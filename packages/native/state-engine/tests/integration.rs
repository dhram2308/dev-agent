// =====================================================================
// state-engine — Integration Tests
// =====================================================================
//
// Tests: HMAC roundtrip, file lock exclusion, atomic write durability,
// stale lock detection
//
// These tests exercise the PUBLIC API across module boundaries, as
// opposed to the inline #[cfg(test)] unit tests which test internals.
// =====================================================================

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use state_engine::hmac::{compute_hmac, verify_hmac};
use state_engine::file_lock::{FileLock, LockError};
use state_engine::atomic_write::atomic_write;

// ── Test helper ─────────────────────────────────────────────────────

fn integration_test_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "state-engine-integration-{}-{}-{}",
        name,
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
    ));
    let _ = fs::create_dir_all(&dir);
    dir
}

fn state_path(dir: &Path, name: &str) -> String {
    dir.join(format!("state-{}.json", name))
        .to_string_lossy()
        .to_string()
}

// ═══════════════════════════════════════════════════════════════════════
// HMAC Roundtrip Tests
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn hmac_roundtrip_compute_then_verify_returns_true() {
    let secret = b"integration-test-secret-key-32by";
    let data = r#"{"stage":"fetch_ticket","ticket":"AUT-8031","data":{"code_branch":"enterprise-ts-AUT-8031"}}"#;

    let tag = compute_hmac(secret, data);
    assert_eq!(tag.len(), 32, "HMAC-SHA256 must produce 32 bytes");
    assert!(
        verify_hmac(secret, data, &tag),
        "HMAC verification must succeed for matching secret+data"
    );
}

#[test]
fn hmac_roundtrip_wrong_data_returns_false() {
    let secret = b"integration-test-secret-key-32by";
    let original_data = r#"{"stage":"fetch_ticket","ticket":"AUT-8031"}"#;
    let tampered_data = r#"{"stage":"fetch_ticket","ticket":"AUT-9999"}"#;

    let tag = compute_hmac(secret, original_data);
    assert!(
        !verify_hmac(secret, tampered_data, &tag),
        "HMAC verification must fail when data has been tampered with"
    );
}

#[test]
fn hmac_roundtrip_wrong_secret_returns_false() {
    let data = r#"{"stage":"generate_code","data":{"code_mr_iid":42}}"#;
    let correct_secret = b"correct-secret-for-hmac-test-xx";
    let wrong_secret = b"wrong-secret-should-not-match-x";

    let tag = compute_hmac(correct_secret, data);
    assert!(
        !verify_hmac(wrong_secret, data, &tag),
        "HMAC verification must fail when secret does not match"
    );
}

#[test]
fn hmac_empty_data_roundtrip() {
    let secret = b"secret-for-empty-test-key";
    let data = "";

    let tag = compute_hmac(secret, data);
    assert!(
        verify_hmac(secret, data, &tag),
        "HMAC roundtrip on empty data must succeed"
    );
}

#[test]
fn hmac_large_data_roundtrip() {
    let secret = b"secret-for-large-data-test";
    // 1MB of JSON-like content
    let data = format!(
        r#"{{"stage":"test","payload":"{}"}}"#,
        "x".repeat(1_000_000)
    );

    let tag = compute_hmac(secret, &data);
    assert!(
        verify_hmac(secret, &data, &tag),
        "HMAC roundtrip on large data must succeed"
    );
}

#[test]
fn hmac_different_secrets_produce_different_tags() {
    let data = r#"{"same":"data"}"#;
    let tag1 = compute_hmac(b"secret-alpha", data);
    let tag2 = compute_hmac(b"secret-bravo", data);
    assert_ne!(
        tag1, tag2,
        "Different secrets must produce different HMAC tags"
    );
}

// ═══════════════════════════════════════════════════════════════════════
// File Lock Exclusion Tests
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn file_lock_acquire_and_release() {
    let dir = integration_test_dir("lock-basic");
    let sp = state_path(&dir, "lock-basic");
    let lock_file = format!("{}.wlock", sp);

    let lock = FileLock::acquire(&sp, 2000).expect("First lock acquisition should succeed");
    assert!(
        Path::new(&lock_file).exists(),
        "Lock file should exist after acquisition"
    );

    drop(lock);
    assert!(
        !Path::new(&lock_file).exists(),
        "Lock file should be removed after Drop"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn file_lock_exclusion_second_acquire_must_fail_with_timeout() {
    let dir = integration_test_dir("lock-exclusion");
    let sp = state_path(&dir, "lock-exclusion");

    // Acquire first lock
    let lock1 = FileLock::acquire(&sp, 2000).expect("First lock should succeed");

    // Second acquire with short timeout must fail (same PID, so not stale)
    let result = FileLock::acquire(&sp, 200);
    assert!(result.is_err(), "Second lock must fail while first is held");

    match result.unwrap_err() {
        LockError::Timeout { timeout_ms, .. } => {
            assert_eq!(timeout_ms, 200, "Timeout value in error must match requested timeout");
        }
        other => panic!("Expected LockError::Timeout, got: {:?}", other),
    }

    // Release first, then second acquire should succeed
    drop(lock1);

    let lock2 = FileLock::acquire(&sp, 2000)
        .expect("Lock acquisition after first release should succeed");
    drop(lock2);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn file_lock_explicit_release_then_reacquire() {
    let dir = integration_test_dir("lock-explicit");
    let sp = state_path(&dir, "lock-explicit");

    let mut lock1 = FileLock::acquire(&sp, 2000).expect("First lock should succeed");
    lock1.release();

    let lock2 = FileLock::acquire(&sp, 2000)
        .expect("Lock after explicit release should succeed");
    drop(lock2);

    let _ = fs::remove_dir_all(&dir);
}

// ═══════════════════════════════════════════════════════════════════════
// Stale Lock Detection Tests
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn stale_lock_detection_dead_pid() {
    let dir = integration_test_dir("stale-dead");
    let sp = state_path(&dir, "stale-dead");
    let lock_file = format!("{}.wlock", sp);

    // Create a lock file with a PID that almost certainly does not exist
    let fake_pid = 4_000_000_000u64; // Way beyond typical PID range
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let fake_lock = format!(
        r#"{{"pid":{},"ts":{},"host":"integration-test"}}"#,
        fake_pid, now_ms
    );
    fs::write(&lock_file, fake_lock).expect("Should be able to write fake lock file");

    // Acquire should succeed by detecting the stale lock (dead PID)
    let lock = FileLock::acquire(&sp, 2000)
        .expect("Should acquire lock after detecting dead PID stale lock");

    // Verify the lock file now contains our PID
    let content = fs::read_to_string(&lock_file).unwrap();
    assert!(
        content.contains(&format!("\"pid\":{}", std::process::id())),
        "Lock file should now contain our PID"
    );

    drop(lock);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn stale_lock_detection_corrupted_lock_file() {
    let dir = integration_test_dir("stale-corrupt");
    let sp = state_path(&dir, "stale-corrupt");
    let lock_file = format!("{}.wlock", sp);

    // Write garbage to the lock file
    fs::write(&lock_file, "THIS IS NOT VALID JSON AT ALL").unwrap();

    // Acquire should succeed by removing the corrupted lock
    let lock = FileLock::acquire(&sp, 2000)
        .expect("Should acquire lock after removing corrupted lock file");

    drop(lock);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn stale_lock_detection_old_timestamp() {
    let dir = integration_test_dir("stale-old-ts");
    let sp = state_path(&dir, "stale-old-ts");
    let lock_file = format!("{}.wlock", sp);

    // Create a lock file with our PID but an ancient timestamp (60s ago)
    let old_ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        - 60_000; // 60 seconds ago, well past the 30s stale threshold
    let fake_lock = format!(
        r#"{{"pid":{},"ts":{},"host":"integration-test"}}"#,
        std::process::id(),
        old_ts
    );
    fs::write(&lock_file, fake_lock).unwrap();

    // Should acquire because lock is older than 30s stale threshold
    let lock = FileLock::acquire(&sp, 2000)
        .expect("Should acquire lock after detecting old-timestamp stale lock");

    drop(lock);
    let _ = fs::remove_dir_all(&dir);
}

// ═══════════════════════════════════════════════════════════════════════
// Atomic Write Durability Tests
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn atomic_write_write_data_then_read_back_matches() {
    let dir = integration_test_dir("atomic-basic");
    let target = dir.join("state-basic.json");
    let target_str = target.to_str().unwrap();
    let data = r#"{"version":3,"state":{"stage":"fetch_ticket","ticket":"AUT-8031","data":{"code_branch":"enterprise-ts-AUT-8031"}}}"#;

    atomic_write(target_str, data).expect("Atomic write should succeed");

    let content = fs::read_to_string(&target).expect("Should be able to read written file");
    assert_eq!(content, data, "Read content must exactly match written data");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn atomic_write_overwrite_existing_file() {
    let dir = integration_test_dir("atomic-overwrite");
    let target = dir.join("state-overwrite.json");
    let target_str = target.to_str().unwrap();

    // Write initial content
    let initial = r#"{"version":3,"state":{"stage":"fetch_ticket"}}"#;
    atomic_write(target_str, initial).unwrap();

    // Overwrite with new content
    let updated = r#"{"version":3,"state":{"stage":"generate_code","data":{"code_mr_iid":42}}}"#;
    atomic_write(target_str, updated).unwrap();

    let content = fs::read_to_string(&target).unwrap();
    assert_eq!(content, updated, "File should contain the overwritten content");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn atomic_write_no_partial_write_on_failure() {
    let dir = integration_test_dir("atomic-no-partial");
    let target = dir.join("state-no-partial.json");
    let target_str = target.to_str().unwrap();

    // Write initial valid content
    let initial = r#"{"version":3,"stage":"fetch_ticket","intact":true}"#;
    atomic_write(target_str, initial).unwrap();

    // Attempt to write to a path where the parent dir doesn't exist
    // This should fail at the temp file creation step
    let bad_path = dir.join("nonexistent-subdir").join("will-fail.json");
    let result = atomic_write(bad_path.to_str().unwrap(), "this should not be written");
    assert!(result.is_err(), "Write to nonexistent parent dir should fail");

    // Original file should be completely intact
    let content = fs::read_to_string(&target).unwrap();
    assert_eq!(
        content, initial,
        "Original file must be untouched after a failed write to a different path"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn atomic_write_no_leftover_tmp_files_after_success() {
    let dir = integration_test_dir("atomic-no-tmp");
    let target = dir.join("state-no-tmp.json");
    let target_str = target.to_str().unwrap();

    atomic_write(target_str, "test-data").unwrap();

    // Scan directory for .tmp files
    let tmp_files: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains(".tmp."))
        .collect();

    assert!(
        tmp_files.is_empty(),
        "No tmp files should remain after successful atomic write"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn atomic_write_large_data_roundtrip() {
    let dir = integration_test_dir("atomic-large");
    let target = dir.join("state-large.json");
    let target_str = target.to_str().unwrap();

    // 2MB of data
    let data = "L".repeat(2_000_000);
    atomic_write(target_str, &data).unwrap();

    let content = fs::read_to_string(&target).unwrap();
    assert_eq!(content.len(), 2_000_000, "Large file should be fully written");
    assert_eq!(content, data, "Large file content must match");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn atomic_write_empty_data() {
    let dir = integration_test_dir("atomic-empty");
    let target = dir.join("state-empty.json");
    let target_str = target.to_str().unwrap();

    atomic_write(target_str, "").unwrap();

    let content = fs::read_to_string(&target).unwrap();
    assert_eq!(content, "", "Empty write should produce empty file");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn atomic_write_preserves_0600_permissions() {
    let dir = integration_test_dir("atomic-perms");
    let target = dir.join("state-perms.json");
    let target_str = target.to_str().unwrap();

    atomic_write(target_str, "permission-test").unwrap();

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = fs::metadata(&target).unwrap();
        let mode = meta.mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "Atomic write should create file with 0600 permissions, got {:o}",
            mode
        );
    }

    let _ = fs::remove_dir_all(&dir);
}

// ═══════════════════════════════════════════════════════════════════════
// Combined: HMAC + Atomic Write End-to-End
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn end_to_end_hmac_then_atomic_write_then_verify() {
    let dir = integration_test_dir("e2e-hmac-write");
    let target = dir.join("state-e2e.json");
    let target_str = target.to_str().unwrap();
    let secret = b"e2e-integration-test-secret-key!";
    let state_json = r#"{"stage":"deploy_qa","ticket":"AUT-1234","data":{"qa_merged":true}}"#;

    // Compute HMAC over the state JSON
    let tag = compute_hmac(secret, state_json);

    // Wrap into an "envelope" with the HMAC (hex-encoded)
    let hmac_hex: String = tag.iter().map(|b| format!("{:02x}", b)).collect();
    let envelope = format!(
        r#"{{"_version":3,"_hmac":"{}","state":{}}}"#,
        hmac_hex, state_json
    );

    // Atomically write to disk
    atomic_write(target_str, &envelope).unwrap();

    // Read back and verify
    let content = fs::read_to_string(&target).unwrap();
    assert!(content.contains(&hmac_hex), "Envelope should contain the HMAC hex string");

    // Verify the HMAC of the state portion
    assert!(
        verify_hmac(secret, state_json, &tag),
        "HMAC verification of the stored state should succeed"
    );

    let _ = fs::remove_dir_all(&dir);
}

// ═══════════════════════════════════════════════════════════════════════
// Combined: Lock + Atomic Write
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn lock_then_atomic_write_then_release() {
    let dir = integration_test_dir("lock-write");
    let sp = state_path(&dir, "lock-write");
    let data = r#"{"stage":"test_qa","data":{"qa_test":"passed"}}"#;

    // Acquire lock
    let lock = FileLock::acquire(&sp, 2000).expect("Lock should succeed");

    // Perform atomic write while holding lock
    atomic_write(&sp, data).expect("Atomic write under lock should succeed");

    // Release lock
    drop(lock);

    // Verify data persisted
    let content = fs::read_to_string(&sp).unwrap();
    assert_eq!(content, data, "Data written under lock should persist after release");

    let _ = fs::remove_dir_all(&dir);
}
