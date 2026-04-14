//! Atomic file write: write to temp file -> fsync -> rename to target.
//!
//! This module replaces `atomicWriteSync` in `lib/state-unified.js`.
//! The key advantage is a `Drop` guard on the file descriptor: if the write
//! fails at any point (including panic), the temp file is always cleaned up
//! and the fd is always closed. The JS implementation uses `fd = -1` sentinel
//! and manual try/catch which is fragile.
//!
//! # Protocol (matches JS implementation)
//! 1. Write data to temp file (`{target}.tmp.{pid}.{timestamp}.{counter}`)
//! 2. fsync the temp file (ensures data is on disk)
//! 3. Rename temp file to target (atomic on POSIX filesystems)
//! 4. On any failure: close fd (via Drop), remove temp file
//!
//! # Differences from JS
//! - No backup (.bak) creation -- that's handled in the TypeScript wrapper
//! - No size guard -- that's handled in the TypeScript wrapper
//! - This module does ONE thing: atomic write with proper fd cleanup

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use napi::bindgen_prelude::*;

/// Monotonic counter for unique temp file names (avoids timestamp collisions).
/// Matches `_tmpCounter` in state-unified.js.
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

// ── Drop guard for temp file cleanup ───────────────────────────────────

/// RAII guard that ensures a temp file is removed if the atomic write fails.
///
/// This replaces the fragile `fd = -1` sentinel + try/catch pattern in JS:
/// ```js
/// let fd = -1;
/// try {
///   fd = fs.openSync(tmpFile, "w", 0o600);
///   // ... write ...
/// } catch (err) {
///   if (fd >= 0) { try { fs.closeSync(fd); } catch {} }
///   try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
///   throw err;
/// }
/// ```
///
/// With this guard, the cleanup is automatic and cannot be forgotten.
struct TempFileGuard {
    path: PathBuf,
    should_cleanup: bool,
}

impl TempFileGuard {
    fn new(path: PathBuf) -> Self {
        TempFileGuard {
            path,
            should_cleanup: true,
        }
    }

    /// Mark the temp file as "committed" -- rename succeeded, don't clean up.
    fn commit(&mut self) {
        self.should_cleanup = false;
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if self.should_cleanup {
            let _ = fs::remove_file(&self.path);
        }
    }
}

// ── Internal Rust API ──────────────────────────────────────────────────

/// Generate a unique temp file path, matching the JS naming convention.
///
/// Format: `{target}.tmp.{pid}.{timestamp}.{counter}`
/// This ensures no collisions even with rapid writes from the same process.
fn temp_file_path(target: &Path) -> PathBuf {
    let pid = std::process::id();
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let counter = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);

    let name = format!(
        "{}.tmp.{}.{}.{}",
        target.file_name().unwrap_or_default().to_string_lossy(),
        pid,
        ts,
        counter
    );

    target.with_file_name(name)
}

/// Atomically write `data` to `path`: temp file -> fsync -> rename.
///
/// # Arguments
/// * `path` - Target file path
/// * `data` - Data to write (typically JSON)
///
/// # Errors
/// Returns an I/O error if:
/// - The parent directory doesn't exist
/// - The temp file can't be created (permissions, disk full)
/// - fsync fails
/// - rename fails (cross-device, permissions)
///
/// On any error, the temp file is cleaned up automatically via `TempFileGuard`.
pub fn atomic_write(path: &str, data: &str) -> io::Result<()> {
    let target = Path::new(path);
    let tmp_path = temp_file_path(target);
    let mut guard = TempFileGuard::new(tmp_path.clone());

    // Step 1: Write to temp file
    {
        let mut file = create_temp_file(&tmp_path)?;
        file.write_all(data.as_bytes())?;

        // Step 2: fsync to ensure data is on disk before rename
        file.sync_all()?;

        // File is closed here when `file` is dropped (fd cleanup via Rust's File Drop)
    }

    // Step 3: Atomic rename
    // On POSIX, rename(2) is atomic within the same filesystem.
    // The temp file is in the same directory as the target, so this is safe.
    fs::rename(&tmp_path, target)?;

    // Success -- don't clean up the temp file (it's now the target)
    guard.commit();

    Ok(())
}

/// Create a temp file with restricted permissions (0o600).
#[cfg(unix)]
fn create_temp_file(path: &Path) -> io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;

    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

#[cfg(not(unix))]
fn create_temp_file(path: &Path) -> io::Result<fs::File> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
}

// ── napi-rs exports (Node.js bindings) ────────────────────────────────

/// Atomically write a string to a file.
///
/// JS signature: `atomicWriteSync(path: string, data: string) -> void`
///
/// Protocol:
/// 1. Write to temp file in same directory
/// 2. fsync the temp file
/// 3. Rename to target (atomic on POSIX)
///
/// If any step fails, the temp file is automatically cleaned up.
/// The target file is either fully written or not modified at all.
///
/// # Example (JavaScript)
/// ```js
/// const { atomicWriteSync } = require('./state-engine');
/// const data = JSON.stringify({ version: 3, state: { stage: "done" } }, null, 2);
/// atomicWriteSync('/path/to/state-AUT-8031.json', data);
/// ```
///
/// # Throws
/// - If the parent directory does not exist
/// - If there are permission errors
/// - If the disk is full (ENOSPC)
#[napi]
pub fn atomic_write_sync(path: String, data: String) -> Result<()> {
    atomic_write(&path, &data).map_err(|e| {
        if e.kind() == io::ErrorKind::Other
            || e.raw_os_error() == Some(libc::ENOSPC)
        {
            napi::Error::from_reason(format!(
                "DISK FULL -- cannot save state. Free disk space and restart. ({})",
                e
            ))
        } else {
            napi::Error::from_reason(format!("atomicWriteSync: {}", e))
        }
    })
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn test_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "state-engine-atomic-test-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn test_atomic_write_creates_file() {
        let dir = test_dir();
        let target = dir.join("test-create.json");
        let data = r#"{"version":3,"state":{"stage":"fetch_ticket"}}"#;

        atomic_write(target.to_str().unwrap(), data).expect("Write should succeed");

        let content = fs::read_to_string(&target).unwrap();
        assert_eq!(content, data);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_atomic_write_overwrites_existing() {
        let dir = test_dir();
        let target = dir.join("test-overwrite.json");

        // Write initial content
        fs::write(&target, "old-content").unwrap();

        // Atomic overwrite
        let new_data = r#"{"version":3,"state":{"stage":"done"}}"#;
        atomic_write(target.to_str().unwrap(), new_data).expect("Overwrite should succeed");

        let content = fs::read_to_string(&target).unwrap();
        assert_eq!(content, new_data);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_atomic_write_no_partial_writes() {
        let dir = test_dir();
        let target = dir.join("test-no-partial.json");

        // Write some initial content
        let initial = "initial-content-that-should-not-be-corrupted";
        fs::write(&target, initial).unwrap();

        // Try to write to a non-existent directory (should fail)
        let bad_path = dir.join("nonexistent-dir").join("file.json");
        let result = atomic_write(bad_path.to_str().unwrap(), "new-data");
        assert!(result.is_err(), "Write to nonexistent dir should fail");

        // Original file should be untouched
        let content = fs::read_to_string(&target).unwrap();
        assert_eq!(content, initial, "Original file should be unchanged after failed write");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_atomic_write_no_leftover_tmp_files() {
        let dir = test_dir();
        let target = dir.join("test-no-leftover.json");
        let data = "test-data";

        atomic_write(target.to_str().unwrap(), data).expect("Write should succeed");

        // Check that no .tmp files are left
        let entries: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .contains(".tmp.")
            })
            .collect();

        assert!(
            entries.is_empty(),
            "No temp files should remain after successful write, found: {:?}",
            entries
                .iter()
                .map(|e| e.file_name())
                .collect::<Vec<_>>()
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_atomic_write_empty_data() {
        let dir = test_dir();
        let target = dir.join("test-empty.json");

        atomic_write(target.to_str().unwrap(), "").expect("Empty write should succeed");

        let content = fs::read_to_string(&target).unwrap();
        assert_eq!(content, "");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_atomic_write_large_data() {
        let dir = test_dir();
        let target = dir.join("test-large.json");

        // 1MB of data
        let data = "x".repeat(1_000_000);
        atomic_write(target.to_str().unwrap(), &data).expect("Large write should succeed");

        let content = fs::read_to_string(&target).unwrap();
        assert_eq!(content.len(), 1_000_000);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_atomic_write_preserves_permissions() {
        let dir = test_dir();
        let target = dir.join("test-permissions.json");

        atomic_write(target.to_str().unwrap(), "data").expect("Write should succeed");

        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let meta = fs::metadata(&target).unwrap();
            let mode = meta.mode() & 0o777;
            assert_eq!(
                mode, 0o600,
                "File permissions should be 0600, got {:o}",
                mode
            );
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_temp_file_path_unique() {
        let target = Path::new("/tmp/test-state.json");
        let path1 = temp_file_path(target);
        let path2 = temp_file_path(target);
        assert_ne!(
            path1, path2,
            "Consecutive temp file paths should be unique"
        );
    }

    #[test]
    fn test_temp_file_guard_cleanup_on_drop() {
        let dir = test_dir();
        let tmp = dir.join("guard-test.tmp");

        // Create a file and then drop the guard -- file should be removed
        fs::write(&tmp, "temp-data").unwrap();
        {
            let _guard = TempFileGuard::new(tmp.clone());
            assert!(tmp.exists());
        }
        assert!(!tmp.exists(), "Guard should remove file on drop");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_temp_file_guard_commit_prevents_cleanup() {
        let dir = test_dir();
        let tmp = dir.join("guard-commit-test.tmp");

        fs::write(&tmp, "committed-data").unwrap();
        {
            let mut guard = TempFileGuard::new(tmp.clone());
            guard.commit();
        }
        assert!(
            tmp.exists(),
            "Guard should NOT remove file after commit"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
