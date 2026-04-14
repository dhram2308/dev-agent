//! RAII file locking using O_EXCL (create exclusive).
//!
//! This module replaces the `acquireLockSync` / `acquireLockAsync` functions in
//! `lib/state-lock.js`. The key advantage of the Rust implementation is the `Drop`
//! trait: the lock file is ALWAYS removed when the `FileLock` goes out of scope,
//! even if the caller forgets to release it or a panic occurs. In JS, this requires
//! try/finally which can be forgotten.
//!
//! # Lock protocol
//! - Lock file path: `{state_file}.wlock` (same as JS implementation)
//! - Lock file content: JSON `{"pid": <pid>, "ts": <epoch_ms>, "host": "<hostname>"}`
//! - Stale detection: if lock file's PID is dead (kill(pid, 0) fails), lock is stale
//! - Stale timeout: if lock age > 30s and PID is alive, still considered stale
//!   (a file write should never take 30s)
//!
//! # Differences from JS implementation
//! - No in-process mutex layer (that's handled in the TypeScript wrapper in lock.ts)
//! - This module only handles the OS-level file lock (Layer 2 in the JS design)
//! - The TypeScript wrapper adds Layer 1 (in-process Promise queue) on top

use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use napi::bindgen_prelude::*;

/// How old a lock from a live PID must be before we consider it stale (30s).
/// Matches STALE_LOCK_AGE_MS in state-lock.js.
const STALE_LOCK_AGE_MS: u64 = 30_000;

/// Default retry interval when polling for lock acquisition (50ms).
/// Matches DEFAULT_RETRY_INTERVAL_MS in state-lock.js.
const DEFAULT_RETRY_INTERVAL_MS: u64 = 50;

// ── Error types ────────────────────────────────────────────────────────

/// Errors that can occur during lock operations.
#[derive(Debug)]
pub enum LockError {
    /// Timed out waiting to acquire the lock.
    Timeout {
        timeout_ms: u64,
        holder_pid: Option<u32>,
        holder_since: Option<u64>,
        lock_path: String,
    },
    /// An I/O error occurred (not EEXIST -- those are handled internally).
    Io(io::Error),
}

impl fmt::Display for LockError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LockError::Timeout {
                timeout_ms,
                holder_pid,
                holder_since,
                lock_path,
            } => {
                write!(
                    f,
                    "StateLock: timeout acquiring lock after {}ms. Held by PID {} since {}. Lock file: {}",
                    timeout_ms,
                    holder_pid.map(|p| p.to_string()).unwrap_or_else(|| "?".to_string()),
                    holder_since
                        .map(|ts| {
                            // Format epoch ms as ISO string (best effort)
                            let secs = ts / 1000;
                            let _nanos = (ts % 1000) as u32 * 1_000_000;
                            format!("epoch:{}", secs)
                        })
                        .unwrap_or_else(|| "?".to_string()),
                    lock_path
                )
            }
            LockError::Io(e) => write!(f, "StateLock: I/O error: {}", e),
        }
    }
}

impl std::error::Error for LockError {}

impl From<io::Error> for LockError {
    fn from(e: io::Error) -> Self {
        LockError::Io(e)
    }
}

// ── Lock info (JSON written to .wlock file) ────────────────────────────

/// Metadata written into the lock file for diagnostics and stale detection.
#[derive(Debug)]
struct LockInfo {
    pid: u32,
    ts: u64,
    host: String,
}

impl LockInfo {
    /// Create lock info for the current process.
    fn current() -> Self {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        LockInfo {
            pid: std::process::id(),
            ts,
            host: hostname(),
        }
    }

    /// Serialize to JSON string (matching JS lockPayload format).
    fn to_json(&self) -> String {
        format!(
            r#"{{"pid":{},"ts":{},"host":"{}"}}"#,
            self.pid, self.ts, self.host
        )
    }

    /// Parse lock info from a JSON string. Returns None on any parse failure.
    fn from_json(s: &str) -> Option<Self> {
        // Simple manual JSON parsing to avoid serde dependency.
        // Format: {"pid":12345,"ts":1234567890123,"host":"hostname"}
        let pid = extract_json_number(s, "pid")?;
        let ts = extract_json_number(s, "ts")?;
        let host = extract_json_string(s, "host").unwrap_or_default();
        Some(LockInfo {
            pid: pid as u32,
            ts,
            host,
        })
    }
}

/// Extract a numeric value from a JSON string by key name.
fn extract_json_number(json: &str, key: &str) -> Option<u64> {
    let pattern = format!(r#""{}":"#, key);
    let start = json.find(&pattern)? + pattern.len();
    let rest = &json[start..];
    let end = rest.find(|c: char| !c.is_ascii_digit())?;
    rest[..end].parse().ok()
}

/// Extract a string value from a JSON string by key name.
fn extract_json_string(json: &str, key: &str) -> Option<String> {
    let pattern = format!(r#""{}":""#, key);
    let start = json.find(&pattern)? + pattern.len();
    let rest = &json[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// Get the hostname (best effort, falls back to "unknown").
fn hostname() -> String {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        let result = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
        if result == 0 {
            let len = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
            String::from_utf8_lossy(&buf[..len]).to_string()
        } else {
            "unknown".to_string()
        }
    }
    #[cfg(not(unix))]
    {
        "unknown".to_string()
    }
}

// ── PID liveness check ─────────────────────────────────────────────────

/// Check if a process with the given PID is alive.
/// Uses kill(pid, 0) which checks existence without sending a signal.
/// Matches `isPidAlive()` in state-lock.js.
fn is_pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }
    #[cfg(not(unix))]
    {
        // On non-Unix, assume alive (conservative)
        let _ = pid;
        true
    }
}

// ── Stale lock detection ───────────────────────────────────────────────

/// Attempt to break a stale lock. Returns true if the lock was broken.
///
/// A lock is considered stale if:
/// 1. The lock file is corrupted/unparseable
/// 2. The owning PID is dead (kill(pid, 0) fails)
/// 3. The lock is older than STALE_LOCK_AGE_MS (30s) even if PID is alive
fn try_break_stale_lock(lock_path: &Path) -> bool {
    let content = match fs::read_to_string(lock_path) {
        Ok(c) => c,
        Err(_) => {
            // Can't read -- try to remove (might be corrupted)
            let _ = fs::remove_file(lock_path);
            return true;
        }
    };

    let info = match LockInfo::from_json(&content) {
        Some(i) => i,
        None => {
            // Corrupted lock file -- remove it
            let _ = fs::remove_file(lock_path);
            return true;
        }
    };

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let lock_age = now_ms.saturating_sub(info.ts);
    let owner_alive = is_pid_alive(info.pid);

    // PID is dead -- definitely stale
    if !owner_alive {
        let _ = fs::remove_file(lock_path);
        return true;
    }

    // PID is alive but lock is extremely old (>30s is abnormal for a file write)
    if lock_age > STALE_LOCK_AGE_MS {
        let _ = fs::remove_file(lock_path);
        return true;
    }

    false
}

/// Read lock info from a lock file (for error messages).
fn read_lock_info(lock_path: &Path) -> Option<LockInfo> {
    let content = fs::read_to_string(lock_path).ok()?;
    LockInfo::from_json(&content)
}

// ── RAII File Lock ─────────────────────────────────────────────────────

/// An exclusive file lock backed by a `.wlock` file.
///
/// The lock is automatically released when this struct is dropped (RAII).
/// This is the key advantage over the JS implementation: even panics, early
/// returns, and forgotten cleanup paths will release the lock.
///
/// # Safety
/// The lock file is created with O_CREAT | O_EXCL (exclusive create).
/// Only one process can hold the lock at a time.
pub struct FileLock {
    /// Path to the .wlock file
    path: PathBuf,
    /// Whether the lock has been explicitly released (to avoid double-remove in Drop)
    released: bool,
}

impl FileLock {
    /// Acquire a file lock with timeout and polling.
    ///
    /// # Arguments
    /// * `state_file_path` - Path to the state file (lock file = state_file + ".wlock")
    /// * `timeout_ms` - Maximum time to wait for the lock (in milliseconds)
    ///
    /// # Returns
    /// A `FileLock` that will auto-release on drop.
    ///
    /// # Errors
    /// - `LockError::Timeout` if the lock cannot be acquired within the timeout
    /// - `LockError::Io` for unexpected I/O errors (not EEXIST)
    pub fn acquire(state_file_path: &str, timeout_ms: u64) -> Result<Self, LockError> {
        let lock_path = PathBuf::from(format!("{}.wlock", state_file_path));
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let retry_interval = Duration::from_millis(DEFAULT_RETRY_INTERVAL_MS);

        loop {
            // Try to create lock file exclusively
            match create_lock_file_exclusive(&lock_path) {
                Ok(()) => {
                    return Ok(FileLock {
                        path: lock_path,
                        released: false,
                    });
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                    // Lock file exists -- try to break stale
                    if try_break_stale_lock(&lock_path) {
                        // Stale lock broken, retry immediately
                        continue;
                    }

                    // Check timeout
                    if Instant::now() >= deadline {
                        let info = read_lock_info(&lock_path);
                        return Err(LockError::Timeout {
                            timeout_ms,
                            holder_pid: info.as_ref().map(|i| i.pid),
                            holder_since: info.as_ref().map(|i| i.ts),
                            lock_path: lock_path.to_string_lossy().to_string(),
                        });
                    }

                    // Wait before retrying
                    thread::sleep(retry_interval);
                }
                Err(e) => {
                    return Err(LockError::Io(e));
                }
            }
        }
    }

    /// Explicitly release the lock (removes the lock file).
    ///
    /// This is idempotent -- calling it multiple times is safe.
    /// Normally you don't need to call this; the Drop impl handles it.
    pub fn release(&mut self) {
        if !self.released {
            self.released = true;
            let _ = fs::remove_file(&self.path);
        }
    }

    /// Get the path to the lock file.
    pub fn lock_path(&self) -> &Path {
        &self.path
    }
}

impl Drop for FileLock {
    /// Automatically release the lock when the struct is dropped.
    /// This is the RAII guarantee: the lock is ALWAYS released, even on panic.
    fn drop(&mut self) {
        self.release();
    }
}

/// Create a lock file exclusively using O_CREAT | O_EXCL.
/// Writes the current process's PID, timestamp, and hostname.
#[cfg(unix)]
fn create_lock_file_exclusive(lock_path: &Path) -> io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;

    let info = LockInfo::current();
    let payload = info.to_json();

    // O_CREAT | O_EXCL | O_WRONLY -- fails with AlreadyExists if file exists
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true) // This is O_CREAT | O_EXCL
        .mode(0o600)
        .open(lock_path)?;

    file.write_all(payload.as_bytes())?;
    file.flush()?;

    Ok(())
}

#[cfg(not(unix))]
fn create_lock_file_exclusive(lock_path: &Path) -> io::Result<()> {
    let info = LockInfo::current();
    let payload = info.to_json();

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(lock_path)?;

    file.write_all(payload.as_bytes())?;
    file.flush()?;

    Ok(())
}

// ── napi-rs exports (Node.js bindings) ────────────────────────────────

/// A file lock handle exposed to JavaScript.
///
/// JS usage:
/// ```js
/// const { acquireFileLock } = require('./state-engine');
/// const lock = acquireFileLock('/path/to/state-AUT-8031.json', 5000);
/// try {
///   // ... do work under lock ...
/// } finally {
///   lock.release();
/// }
/// ```
#[napi]
pub struct FileLockHandle {
    /// The inner Rust lock. Using Option so we can take() it on release.
    inner: Option<FileLock>,
}

#[napi]
impl FileLockHandle {
    /// Release the file lock. Idempotent -- safe to call multiple times.
    ///
    /// Note: The lock is also automatically released when the handle is
    /// garbage collected by V8, but you should always explicitly release
    /// in a finally block for deterministic cleanup.
    #[napi]
    pub fn release(&mut self) {
        if let Some(ref mut lock) = self.inner {
            lock.release();
        }
        self.inner = None;
    }

    /// Check if the lock is still held (not yet released).
    #[napi(getter)]
    pub fn is_held(&self) -> bool {
        self.inner.is_some()
    }

    /// Get the path to the lock file.
    #[napi(getter)]
    pub fn lock_path(&self) -> Option<String> {
        self.inner
            .as_ref()
            .map(|lock| lock.lock_path().to_string_lossy().to_string())
    }
}

/// Acquire an exclusive file lock with timeout.
///
/// JS signature: `acquireFileLock(path: string, timeoutMs: number) -> FileLockHandle`
///
/// The lock file is created at `{path}.wlock`. If the lock cannot be acquired
/// within `timeoutMs` milliseconds, an error is thrown.
///
/// Stale lock detection: if the lock is held by a dead process (PID check) or
/// is older than 30 seconds, it is automatically broken.
///
/// # Arguments
/// * `path` - Path to the state file (NOT the lock file -- `.wlock` is appended)
/// * `timeout_ms` - Maximum time to wait in milliseconds
///
/// # Returns
/// A `FileLockHandle` with a `release()` method. ALWAYS call `release()` in a
/// finally block.
///
/// # Throws
/// - If timeout expires while waiting for the lock
/// - If an unexpected I/O error occurs
#[napi]
pub fn acquire_file_lock(path: String, timeout_ms: f64) -> Result<FileLockHandle> {
    let timeout = timeout_ms as u64;
    match FileLock::acquire(&path, timeout) {
        Ok(lock) => Ok(FileLockHandle { inner: Some(lock) }),
        Err(LockError::Timeout {
            timeout_ms,
            holder_pid,
            holder_since,
            lock_path,
        }) => Err(napi::Error::from_reason(format!(
            "StateLock: timeout acquiring lock after {}ms. Held by PID {} since {}. Lock file: {}",
            timeout_ms,
            holder_pid
                .map(|p| p.to_string())
                .unwrap_or_else(|| "?".to_string()),
            holder_since
                .map(|ts| ts.to_string())
                .unwrap_or_else(|| "?".to_string()),
            lock_path
        ))),
        Err(LockError::Io(e)) => Err(napi::Error::from_reason(format!(
            "StateLock: I/O error: {}",
            e
        ))),
    }
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Helper to create a temp directory for tests
    fn test_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("state-engine-lock-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        dir
    }

    /// Helper to get a unique state file path
    fn test_state_path(dir: &Path, name: &str) -> String {
        dir.join(format!("state-{}.json", name))
            .to_string_lossy()
            .to_string()
    }

    #[test]
    fn test_acquire_and_release() {
        let dir = test_dir();
        let state_path = test_state_path(&dir, "acquire-release");
        let lock_file = format!("{}.wlock", state_path);

        {
            let lock = FileLock::acquire(&state_path, 1000).expect("Should acquire lock");
            assert!(Path::new(&lock_file).exists(), "Lock file should exist");

            // Verify lock file contains valid JSON with our PID
            let content = fs::read_to_string(&lock_file).unwrap();
            let info = LockInfo::from_json(&content).expect("Lock file should be valid JSON");
            assert_eq!(info.pid, std::process::id());
        }
        // Lock should be released by Drop
        assert!(
            !Path::new(&lock_file).exists(),
            "Lock file should be removed after Drop"
        );

        // Cleanup
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_explicit_release() {
        let dir = test_dir();
        let state_path = test_state_path(&dir, "explicit-release");
        let lock_file = format!("{}.wlock", state_path);

        let mut lock = FileLock::acquire(&state_path, 1000).expect("Should acquire lock");
        assert!(Path::new(&lock_file).exists());

        lock.release();
        assert!(
            !Path::new(&lock_file).exists(),
            "Lock file should be removed after explicit release"
        );

        // Double release should be safe
        lock.release();

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_lock_exclusion() {
        let dir = test_dir();
        let state_path = test_state_path(&dir, "exclusion");

        let lock1 = FileLock::acquire(&state_path, 1000).expect("First lock should succeed");

        // Second lock should timeout (same process, our PID is alive)
        let result = FileLock::acquire(&state_path, 200);
        assert!(result.is_err(), "Second lock should fail with timeout");
        match result.unwrap_err() {
            LockError::Timeout { timeout_ms, .. } => {
                assert_eq!(timeout_ms, 200);
            }
            other => panic!("Expected Timeout error, got: {:?}", other),
        }

        drop(lock1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_stale_lock_detection_dead_pid() {
        let dir = test_dir();
        let state_path = test_state_path(&dir, "stale-dead-pid");
        let lock_file = format!("{}.wlock", state_path);

        // Create a lock file with a definitely-dead PID
        let fake_info = r#"{"pid":999999999,"ts":1000000000000,"host":"test"}"#;
        fs::write(&lock_file, fake_info).unwrap();

        // Should acquire by breaking the stale lock
        let lock = FileLock::acquire(&state_path, 1000)
            .expect("Should acquire lock after breaking stale");
        assert!(Path::new(&lock_file).exists());

        drop(lock);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_stale_lock_detection_old_timestamp() {
        let dir = test_dir();
        let state_path = test_state_path(&dir, "stale-old-ts");
        let lock_file = format!("{}.wlock", state_path);

        // Create a lock file with current PID but very old timestamp
        // (PID is alive but lock is ancient -- should still be broken)
        let old_ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            - 60_000; // 60 seconds ago
        let fake_info = format!(
            r#"{{"pid":{},"ts":{},"host":"test"}}"#,
            std::process::id(),
            old_ts
        );
        fs::write(&lock_file, fake_info).unwrap();

        // Should acquire by breaking the stale lock
        let lock = FileLock::acquire(&state_path, 1000)
            .expect("Should acquire lock after breaking old stale lock");

        drop(lock);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_corrupted_lock_file() {
        let dir = test_dir();
        let state_path = test_state_path(&dir, "corrupted");
        let lock_file = format!("{}.wlock", state_path);

        // Create a corrupted lock file
        fs::write(&lock_file, "not-valid-json!!!").unwrap();

        // Should acquire by breaking the corrupted lock
        let lock = FileLock::acquire(&state_path, 1000)
            .expect("Should acquire lock after breaking corrupted lock");

        drop(lock);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_lock_info_json_roundtrip() {
        let info = LockInfo::current();
        let json = info.to_json();
        let parsed = LockInfo::from_json(&json).expect("Should parse our own JSON");
        assert_eq!(parsed.pid, info.pid);
        assert_eq!(parsed.ts, info.ts);
        assert_eq!(parsed.host, info.host);
    }

    #[test]
    fn test_extract_json_number() {
        assert_eq!(extract_json_number(r#"{"pid":12345,"ts":100}"#, "pid"), Some(12345));
        assert_eq!(extract_json_number(r#"{"pid":12345,"ts":100}"#, "ts"), Some(100));
        assert_eq!(extract_json_number(r#"{"pid":12345}"#, "missing"), None);
    }

    #[test]
    fn test_extract_json_string() {
        assert_eq!(
            extract_json_string(r#"{"host":"myhost","pid":1}"#, "host"),
            Some("myhost".to_string())
        );
        assert_eq!(
            extract_json_string(r#"{"host":"","pid":1}"#, "host"),
            Some("".to_string())
        );
    }
}
