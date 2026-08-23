# Theory D — File-marker IPC for Service Uninstall — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the WTS cross-session spawn in `ServiceApi.handoffUninstallToUserSession` with file-marker IPC so the service-uninstall flow stops failing with `ERROR_ACCESS_DENIED`.

**Architecture:** Service-Node (LocalSystem, session 0) writes a small JSON marker to `<dataRoot>/control/uninstall-handoff.json`. A polling thread inside the user-session tray helper detects it, validates the target session, spawns the launcher in its own session, and deletes the marker. No cross-session token APIs.

**Tech Stack:** Rust (common crate, tray, launcher) for the helper-side; TypeScript (Node service) for the service-side write. Vitest for TS unit tests, `cargo test` for Rust unit tests.

**Spec:** `docs/superpowers/specs/2026-04-29-theory-d-uninstall-handoff-design.md`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `common/src/control_marker.rs` | NEW | Marker schema (`Marker`), atomic write, read, delete, stale-cleanup, blocking poll loop. |
| `common/src/lib.rs` | EDIT | `pub mod control_marker;` |
| `launcher/src/main.rs` | EDIT | Add `--print-active-session` flag handler that prints `WTSGetActiveConsoleSessionId()` to stdout. |
| `tray/src/main.rs` | EDIT | Spawn poller thread before `tray::run(...)`. |
| `src/server/util/active-session.ts` | NEW | Spawns `<launcherPath> --print-active-session`, parses stdout. |
| `src/server/util/control-marker.ts` | NEW | Atomic JSON marker write under `<dataRoot>/control/`. |
| `src/server/api/ServiceApi.ts` | EDIT | `handoffUninstallToUserSession` swaps `runElevated('spawn-user-launcher', ...)` for marker write. |

---

## Phase 1 — Rust `control_marker` module

### Task 1: Add `Marker` struct + serde derive

**Files:**
- Create: `common/src/control_marker.rs`
- Modify: `common/src/lib.rs`
- Test: `common/src/control_marker.rs` (inline `#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing test**

```rust
// inside common/src/control_marker.rs (file does not exist yet)
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Marker {
    pub verb: String,
    #[serde(rename = "targetSessionId")]
    pub target_session_id: Option<u32>,
    #[serde(rename = "launcherPath")]
    pub launcher_path: PathBuf,
    #[serde(rename = "launcherArgs")]
    pub launcher_args: Vec<String>,
    #[serde(rename = "writtenAt")]
    pub written_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_round_trips_through_json() {
        let m = Marker {
            verb: "uninstall-service".to_string(),
            target_session_id: Some(1),
            launcher_path: PathBuf::from(r"C:\Program Files\WsScrcpyWeb\current\ws-scrcpy-web-launcher.exe"),
            launcher_args: vec!["--local-takeover".to_string()],
            written_at: "2026-04-29T23:30:00Z".to_string(),
        };
        let json = serde_json::to_string(&m).expect("serialize");
        let back: Marker = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(m, back);
    }
}
```

Then add to `common/src/lib.rs`:
```rust
pub mod control_marker;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p ws-scrcpy-web-common control_marker::tests::marker_round_trips_through_json`
Expected: PASS (the test only validates structure; if `serde_json` isn't already a `common` dep, expect a compile error first — fix in Step 3).

- [ ] **Step 3: Add `serde_json` to `common/Cargo.toml` if missing**

Check `common/Cargo.toml` — if `serde_json` isn't listed under `[dependencies]`, add:
```toml
serde_json = "1"
```
(Match the version used elsewhere in the workspace via `cargo tree | grep serde_json`.)

- [ ] **Step 4: Re-run test, confirm pass**

Run: `cargo test -p ws-scrcpy-web-common control_marker`
Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add common/src/control_marker.rs common/src/lib.rs common/Cargo.toml common/Cargo.lock 2>/dev/null; git commit -m "feat(common): add control_marker module with Marker struct"
```

---

### Task 2: Atomic write function

**Files:**
- Modify: `common/src/control_marker.rs`

- [ ] **Step 1: Write the failing test**

Append to the `tests` module:
```rust
    #[test]
    fn write_creates_file_atomically_under_control_dir() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let data_root = tmp.path();
        let m = Marker {
            verb: "uninstall-service".to_string(),
            target_session_id: Some(1),
            launcher_path: PathBuf::from("a.exe"),
            launcher_args: vec![],
            written_at: "2026-04-29T23:30:00Z".to_string(),
        };
        write(data_root, &m).expect("write succeeds");
        let target = data_root.join("control").join("uninstall-handoff.json");
        assert!(target.exists(), "marker file exists after write");
        let body = std::fs::read_to_string(&target).expect("readable");
        let parsed: Marker = serde_json::from_str(&body).expect("valid json");
        assert_eq!(parsed, m);
    }

    #[test]
    fn write_overwrites_existing_marker() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let data_root = tmp.path();
        let mk = |session| Marker {
            verb: "uninstall-service".to_string(),
            target_session_id: Some(session),
            launcher_path: PathBuf::from("a.exe"),
            launcher_args: vec![],
            written_at: "2026-04-29T23:30:00Z".to_string(),
        };
        write(data_root, &mk(1)).expect("first write");
        write(data_root, &mk(2)).expect("second write");
        let target = data_root.join("control").join("uninstall-handoff.json");
        let body = std::fs::read_to_string(&target).expect("readable");
        let parsed: Marker = serde_json::from_str(&body).expect("valid json");
        assert_eq!(parsed.target_session_id, Some(2));
    }
```

Add `tempfile = "3"` to `common/Cargo.toml` `[dev-dependencies]` if not present.

- [ ] **Step 2: Run tests, confirm failure**

Run: `cargo test -p ws-scrcpy-web-common control_marker`
Expected: compile error — `write` is not defined.

- [ ] **Step 3: Implement `write`**

Append to `common/src/control_marker.rs`:
```rust
use std::fs;
use std::io;
use std::path::Path;

pub const CONTROL_DIR: &str = "control";
pub const UNINSTALL_HANDOFF_FILENAME: &str = "uninstall-handoff.json";

/// Write a marker atomically under `<data_root>/control/`. The directory
/// is created if missing. Existing markers are overwritten.
pub fn write(data_root: &Path, marker: &Marker) -> io::Result<()> {
    let dir = data_root.join(CONTROL_DIR);
    fs::create_dir_all(&dir)?;
    let final_path = dir.join(UNINSTALL_HANDOFF_FILENAME);
    let tmp_path = dir.join(format!("{}.tmp", UNINSTALL_HANDOFF_FILENAME));
    let json = serde_json::to_vec_pretty(marker)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    fs::write(&tmp_path, &json)?;
    // fs::rename on Windows replaces an existing file when destination is on
    // the same volume — which it always is here (both inside <data_root>).
    fs::rename(&tmp_path, &final_path)?;
    Ok(())
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `cargo test -p ws-scrcpy-web-common control_marker`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add common/src/control_marker.rs common/Cargo.toml common/Cargo.lock 2>/dev/null; git commit -m "feat(common): add atomic write for control markers"
```

---

### Task 3: Read function with stale detection

**Files:**
- Modify: `common/src/control_marker.rs`

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module:
```rust
    #[test]
    fn read_returns_none_when_marker_absent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let result = read(tmp.path()).expect("read does not error on missing");
        assert!(result.is_none());
    }

    #[test]
    fn read_returns_marker_when_present() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let m = Marker {
            verb: "uninstall-service".to_string(),
            target_session_id: Some(1),
            launcher_path: PathBuf::from("a.exe"),
            launcher_args: vec![],
            written_at: "2026-04-29T23:30:00Z".to_string(),
        };
        write(tmp.path(), &m).expect("write");
        let got = read(tmp.path()).expect("read").expect("present");
        assert_eq!(got, m);
    }

    #[test]
    fn read_returns_none_on_corrupt_json() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("control");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(dir.join("uninstall-handoff.json"), b"not json").expect("write");
        // Corrupt content is reported as None, not an error — log+ignore is the
        // caller's preference (poller continues on next tick).
        let result = read(tmp.path()).expect("read does not error on corrupt");
        assert!(result.is_none());
    }
```

- [ ] **Step 2: Run tests, confirm failure**

Run: `cargo test -p ws-scrcpy-web-common control_marker`
Expected: compile error — `read` is not defined.

- [ ] **Step 3: Implement `read`**

Append to `common/src/control_marker.rs`:
```rust
/// Read the marker file from `<data_root>/control/uninstall-handoff.json`.
/// Returns:
///   - `Ok(Some(marker))` if the file exists and parses
///   - `Ok(None)` if the file is absent OR present-but-corrupt
///   - `Err(_)` only on unexpected IO errors (permission denied, etc.)
pub fn read(data_root: &Path) -> io::Result<Option<Marker>> {
    let path = data_root.join(CONTROL_DIR).join(UNINSTALL_HANDOFF_FILENAME);
    let body = match fs::read_to_string(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    Ok(serde_json::from_str(&body).ok())
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `cargo test -p ws-scrcpy-web-common control_marker`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add common/src/control_marker.rs; git commit -m "feat(common): add control_marker read with corrupt-tolerant return"
```

---

### Task 4: Delete + stale cleanup

**Files:**
- Modify: `common/src/control_marker.rs`

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module:
```rust
    #[test]
    fn delete_is_idempotent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // Delete on absent should be Ok
        delete(tmp.path()).expect("delete absent ok");
        // Write + delete + delete-again
        let m = Marker {
            verb: "uninstall-service".to_string(),
            target_session_id: Some(1),
            launcher_path: PathBuf::from("a.exe"),
            launcher_args: vec![],
            written_at: "2026-04-29T23:30:00Z".to_string(),
        };
        write(tmp.path(), &m).expect("write");
        delete(tmp.path()).expect("delete present ok");
        delete(tmp.path()).expect("second delete ok");
        assert!(read(tmp.path()).expect("read").is_none());
    }

    #[test]
    fn cleanup_stale_removes_old_marker() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let old = Marker {
            verb: "uninstall-service".to_string(),
            target_session_id: Some(1),
            launcher_path: PathBuf::from("a.exe"),
            launcher_args: vec![],
            // 5 minutes ago
            written_at: "2026-04-29T23:25:00Z".to_string(),
        };
        write(tmp.path(), &old).expect("write");
        // Pretend "now" is 5 minutes after the marker's written_at
        let now = chrono::DateTime::parse_from_rfc3339("2026-04-29T23:30:00Z").unwrap();
        cleanup_stale(tmp.path(), now.into(), std::time::Duration::from_secs(60));
        assert!(read(tmp.path()).expect("read").is_none());
    }

    #[test]
    fn cleanup_stale_keeps_fresh_marker() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let fresh = Marker {
            verb: "uninstall-service".to_string(),
            target_session_id: Some(1),
            launcher_path: PathBuf::from("a.exe"),
            launcher_args: vec![],
            written_at: "2026-04-29T23:29:30Z".to_string(),
        };
        write(tmp.path(), &fresh).expect("write");
        let now = chrono::DateTime::parse_from_rfc3339("2026-04-29T23:30:00Z").unwrap();
        cleanup_stale(tmp.path(), now.into(), std::time::Duration::from_secs(60));
        assert!(read(tmp.path()).expect("read").is_some());
    }
```

Add `chrono = { version = "0.4", features = ["serde"] }` to `common/Cargo.toml` `[dependencies]` if not present.

- [ ] **Step 2: Run tests, confirm failure**

Run: `cargo test -p ws-scrcpy-web-common control_marker`
Expected: compile error — `delete` and `cleanup_stale` are not defined.

- [ ] **Step 3: Implement `delete` + `cleanup_stale`**

Append to `common/src/control_marker.rs`:
```rust
use chrono::{DateTime, Utc};
use std::time::Duration;

/// Delete the marker file. Idempotent — absent file is not an error.
pub fn delete(data_root: &Path) -> io::Result<()> {
    let path = data_root.join(CONTROL_DIR).join(UNINSTALL_HANDOFF_FILENAME);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// If a marker is present and its `writtenAt` is older than `max_age` from
/// `now`, delete it. Failures are logged-and-ignored (poller continues).
/// Used at tray helper startup to clear leftovers from a crashed previous
/// session.
pub fn cleanup_stale(data_root: &Path, now: DateTime<Utc>, max_age: Duration) {
    let Ok(Some(marker)) = read(data_root) else { return };
    let Ok(written) = DateTime::parse_from_rfc3339(&marker.written_at) else {
        // Unparseable timestamp -> treat as stale (overwrites a malformed marker).
        let _ = delete(data_root);
        return;
    };
    let age = now.signed_duration_since(written.with_timezone(&Utc));
    if age.to_std().map(|d| d > max_age).unwrap_or(false) {
        let _ = delete(data_root);
    }
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `cargo test -p ws-scrcpy-web-common control_marker`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add common/src/control_marker.rs common/Cargo.toml common/Cargo.lock 2>/dev/null; git commit -m "feat(common): add delete + cleanup_stale for control markers"
```

---

### Task 5: Poll loop with session check + spawn

**Files:**
- Modify: `common/src/control_marker.rs`

- [ ] **Step 1: Write the failing test**

Append to the `tests` module:
```rust
    #[test]
    fn poll_once_session_match_spawns_and_deletes() {
        // We don't actually exec a real binary in unit test land. Use a
        // fake spawn closure to validate the contract: marker present +
        // session matches -> spawn called with (path, args) -> marker
        // deleted.
        let tmp = tempfile::tempdir().expect("tempdir");
        let target_exe = PathBuf::from("nonexistent-launcher.exe");
        let m = Marker {
            verb: "uninstall-service".to_string(),
            target_session_id: Some(1),
            launcher_path: target_exe.clone(),
            launcher_args: vec!["--local-takeover".to_string()],
            written_at: "2026-04-29T23:30:00Z".to_string(),
        };
        write(tmp.path(), &m).expect("write");

        let spawn_log = std::sync::Arc::new(std::sync::Mutex::new(Vec::<(PathBuf, Vec<String>)>::new()));
        let log_clone = spawn_log.clone();
        let outcome = poll_once(
            tmp.path(),
            1,
            &mut |path, args| { log_clone.lock().unwrap().push((path.to_path_buf(), args.to_vec())); Ok(()) },
        );
        assert_eq!(outcome, PollOutcome::Spawned);
        let log = spawn_log.lock().unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].0, target_exe);
        assert_eq!(log[0].1, vec!["--local-takeover"]);
        assert!(read(tmp.path()).expect("read").is_none(), "marker deleted after spawn");
    }

    #[test]
    fn poll_once_session_mismatch_ignores() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let m = Marker {
            verb: "uninstall-service".to_string(),
            target_session_id: Some(2),  // for a different session
            launcher_path: PathBuf::from("a.exe"),
            launcher_args: vec![],
            written_at: "2026-04-29T23:30:00Z".to_string(),
        };
        write(tmp.path(), &m).expect("write");
        let outcome = poll_once(tmp.path(), 1, &mut |_, _| panic!("must not spawn"));
        assert_eq!(outcome, PollOutcome::WrongSession);
        assert!(read(tmp.path()).expect("read").is_some(), "marker preserved for other tray helper");
    }

    #[test]
    fn poll_once_no_marker_returns_idle() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let outcome = poll_once(tmp.path(), 1, &mut |_, _| panic!("must not spawn"));
        assert_eq!(outcome, PollOutcome::Idle);
    }

    #[test]
    fn poll_once_null_target_session_spawns_for_any() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let m = Marker {
            verb: "uninstall-service".to_string(),
            target_session_id: None,
            launcher_path: PathBuf::from("a.exe"),
            launcher_args: vec![],
            written_at: "2026-04-29T23:30:00Z".to_string(),
        };
        write(tmp.path(), &m).expect("write");
        let mut spawned = false;
        let outcome = poll_once(tmp.path(), 99, &mut |_, _| { spawned = true; Ok(()) });
        assert_eq!(outcome, PollOutcome::Spawned);
        assert!(spawned);
    }
```

- [ ] **Step 2: Run tests, confirm failure**

Run: `cargo test -p ws-scrcpy-web-common control_marker`
Expected: compile error — `poll_once` and `PollOutcome` are not defined.

- [ ] **Step 3: Implement `poll_once` + `PollOutcome`**

Append to `common/src/control_marker.rs`:
```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PollOutcome {
    /// No marker present.
    Idle,
    /// Marker present but `targetSessionId` doesn't match this tray helper's
    /// session. Marker is left alone so the right tray helper can pick it up.
    WrongSession,
    /// Marker matched, spawn was invoked, marker deleted.
    Spawned,
    /// Spawn returned an error. Marker is NOT deleted so a future tick can
    /// retry (for transient failures like file-locked-by-AV).
    SpawnFailed,
}

/// Run one poll iteration. Returns the outcome. Splitting this out from
/// `poll_for_handoff` makes the loop body unit-testable.
///
/// `spawn` takes `(launcher_path, launcher_args)` and returns Ok(()) on
/// successful spawn (the launcher started; we don't wait for it to bind).
pub fn poll_once<F>(
    data_root: &Path,
    own_session: u32,
    spawn: &mut F,
) -> PollOutcome
where
    F: FnMut(&Path, &[String]) -> io::Result<()>,
{
    let Ok(Some(marker)) = read(data_root) else { return PollOutcome::Idle };
    if let Some(target) = marker.target_session_id {
        if target != own_session {
            return PollOutcome::WrongSession;
        }
    }
    // Convert Vec<String> args into &[String] for the spawn callback.
    match spawn(&marker.launcher_path, &marker.launcher_args) {
        Ok(()) => {
            let _ = delete(data_root);
            PollOutcome::Spawned
        }
        Err(_) => PollOutcome::SpawnFailed,
    }
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `cargo test -p ws-scrcpy-web-common control_marker`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add common/src/control_marker.rs; git commit -m "feat(common): add poll_once with session-match + spawn callback"
```

---

### Task 6: Blocking poll loop wrapper

**Files:**
- Modify: `common/src/control_marker.rs`

- [ ] **Step 1: Implement `poll_for_handoff` (no unit test — thread + sleep is impractical to test in unit-test scope; covered by integration test in Phase 4)**

Append to `common/src/control_marker.rs`:
```rust
/// Production poll loop. Sleeps `cadence` between ticks and spawns
/// processes via `std::process::Command`. Runs forever. Intended to be
/// invoked on a dedicated thread; thread death is caller's problem.
///
/// On entry, calls `cleanup_stale` once with a 60s threshold to clear any
/// leftover marker from a crashed previous tray-helper run.
pub fn poll_for_handoff(data_root: &Path, own_session: u32, cadence: Duration) {
    cleanup_stale(data_root, Utc::now(), Duration::from_secs(60));
    loop {
        let mut spawn = |path: &Path, args: &[String]| -> io::Result<()> {
            std::process::Command::new(path).args(args).spawn().map(|_| ())
        };
        let _ = poll_once(data_root, own_session, &mut spawn);
        std::thread::sleep(cadence);
    }
}
```

- [ ] **Step 2: Build, confirm compile success**

Run: `cargo build -p ws-scrcpy-web-common`
Expected: clean build.

- [ ] **Step 3: Run all tests once more to confirm no regressions**

Run: `cargo test -p ws-scrcpy-web-common control_marker`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add common/src/control_marker.rs; git commit -m "feat(common): add poll_for_handoff blocking loop"
```

---

## Phase 2 — Launcher `--print-active-session` flag

### Task 7: Print active console session ID and exit

**Files:**
- Modify: `launcher/src/main.rs` (insert near other flag dispatches)
- Test: `launcher/tests/print_active_session.rs` (new)

- [ ] **Step 1: Locate the flag-dispatch area in main.rs**

Read `launcher/src/main.rs:160-180` for the existing `--local-takeover` and `--veloapp-*` dispatch shape — add the new flag in the same style. New flag fires VERY early, before any other init, because it's a one-shot stdout query.

- [ ] **Step 2: Write the integration test**

Create `launcher/tests/print_active_session.rs`:
```rust
//! Smoke test: launcher --print-active-session writes a single u32 to
//! stdout and exits 0. We can't assert a specific session value (depends
//! on the test runner's environment), but we can assert the format.

use std::process::Command;

#[test]
fn print_active_session_outputs_a_number() {
    let exe = env!("CARGO_BIN_EXE_ws-scrcpy-web-launcher");
    let out = Command::new(exe)
        .arg("--print-active-session")
        .output()
        .expect("spawn launcher");
    assert!(out.status.success(), "launcher exited non-zero: {:?}", out);
    let stdout = String::from_utf8(out.stdout).expect("utf8 stdout");
    let trimmed = stdout.trim();
    let parsed: u32 = trimmed.parse().expect("session id parses as u32");
    // Sanity: session 0 (LocalSystem) or 1+ (interactive). -1 (0xFFFFFFFF) means
    // no active console; that's a valid degraded state we want to flag separately.
    assert_ne!(parsed, u32::MAX, "expected real session id, got -1 sentinel");
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test -p ws-scrcpy-web-launcher --test print_active_session`
Expected: test launches the launcher, but the launcher does the full startup (does NOT exit on the unknown flag) — hangs or runs as supervisor. Kill with Ctrl+C; this is the failure signal.

(If the existing main treats unknown flags as "ignore and proceed", the launcher will start its supervisor. Don't worry about cleanly killing it for the test — just confirm the FLAG is not yet handled and move to Step 4.)

- [ ] **Step 4: Implement the flag handler**

In `launcher/src/main.rs`, locate where `let args: Vec<String> = std::env::args().collect();` happens (around line 24). Immediately after the args are collected, before any logging or supervisor init, add:

```rust
    // --print-active-session: one-shot Win32 query. Used by the service-Node
    // (running as LocalSystem) to discover the user's interactive session
    // before writing a control marker. Must be early so we don't pay startup
    // cost.
    if args.iter().any(|a| a == "--print-active-session") {
        #[cfg(windows)]
        {
            // SAFETY: WTSGetActiveConsoleSessionId has no preconditions and is
            // safe to call from any context. Returns 0xFFFFFFFF when no
            // session is attached to the physical console.
            let session = unsafe { windows_sys::Win32::System::RemoteDesktop::WTSGetActiveConsoleSessionId() };
            println!("{}", session);
            std::process::exit(0);
        }
        #[cfg(not(windows))]
        {
            // Non-Windows: there's no analog. Service-mode is Windows-only;
            // we shouldn't be invoked here, but exit cleanly anyway.
            println!("0");
            std::process::exit(0);
        }
    }
```

If `windows_sys` isn't already a launcher dep, add to `launcher/Cargo.toml`:
```toml
[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.59", features = ["Win32_System_RemoteDesktop"] }
```
(Match the existing version — `cargo tree -p ws-scrcpy-web-launcher | grep windows-sys`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cargo test -p ws-scrcpy-web-launcher --test print_active_session`
Expected: test passes — stdout contains a u32 like `1` or `0`.

- [ ] **Step 6: Commit**

```bash
git add launcher/src/main.rs launcher/tests/print_active_session.rs launcher/Cargo.toml launcher/Cargo.lock 2>/dev/null; git commit -m "feat(launcher): add --print-active-session flag"
```

---

## Phase 3 — TypeScript helpers

### Task 8: `active-session.ts` — spawn launcher, read stdout

**Files:**
- Create: `src/server/util/active-session.ts`
- Create: `src/server/util/__tests__/active-session.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/util/__tests__/active-session.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { resolveActiveSessionId } from '../active-session';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('resolveActiveSessionId', () => {
    it('returns the integer parsed from the helper exe stdout', async () => {
        // Create a stub script that prints a number and exits 0.
        const dir = mkdtempSync(join(tmpdir(), 'active-session-test-'));
        const stub = join(dir, 'stub.cmd');
        writeFileSync(stub, '@echo off\necho 1\nexit /b 0\n');
        const result = await resolveActiveSessionId(stub);
        expect(result).toEqual({ ok: true, sessionId: 1 });
    });

    it('returns ok:false when the helper exe is missing', async () => {
        const result = await resolveActiveSessionId('Z:\\does\\not\\exist.exe');
        expect(result.ok).toBe(false);
    });

    it('returns ok:false when stdout is not a number', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'active-session-test-'));
        const stub = join(dir, 'stub.cmd');
        writeFileSync(stub, '@echo off\necho hello\nexit /b 0\n');
        const result = await resolveActiveSessionId(stub);
        expect(result.ok).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/util/__tests__/active-session.test.ts`
Expected: import error — `active-session` does not exist.

- [ ] **Step 3: Implement `active-session.ts`**

Create `src/server/util/active-session.ts`:
```ts
import { spawn } from 'node:child_process';

export type ActiveSessionResult =
    | { ok: true; sessionId: number }
    | { ok: false; errorMessage: string };

/**
 * Resolve the user's interactive console session ID by invoking
 * `<launcherPath> --print-active-session` and parsing stdout.
 *
 * Used by the service-Node (LocalSystem) to discover the user's session
 * before writing a control marker. Returns `ok: false` on any failure
 * (missing exe, non-numeric output, non-zero exit) — the caller should
 * fall back to writing the marker without a session filter.
 */
export async function resolveActiveSessionId(launcherPath: string): Promise<ActiveSessionResult> {
    return new Promise((resolve) => {
        const child = spawn(launcherPath, ['--print-active-session'], {
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
        });
        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
        child.on('error', (e) => {
            resolve({ ok: false, errorMessage: e.message });
        });
        child.on('close', (code) => {
            if (code !== 0) {
                resolve({ ok: false, errorMessage: `launcher exited ${code}` });
                return;
            }
            const trimmed = stdout.trim();
            const parsed = Number.parseInt(trimmed, 10);
            if (!Number.isFinite(parsed) || String(parsed) !== trimmed) {
                resolve({ ok: false, errorMessage: `non-numeric stdout: ${JSON.stringify(stdout)}` });
                return;
            }
            resolve({ ok: true, sessionId: parsed });
        });
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/util/__tests__/active-session.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/util/active-session.ts src/server/util/__tests__/active-session.test.ts; git commit -m "feat(server): add resolveActiveSessionId via launcher --print-active-session"
```

---

### Task 9: `control-marker.ts` — atomic JSON write

**Files:**
- Create: `src/server/util/control-marker.ts`
- Create: `src/server/util/__tests__/control-marker.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/util/__tests__/control-marker.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { writeUninstallHandoffMarker } from '../control-marker';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('writeUninstallHandoffMarker', () => {
    it('writes a parseable JSON marker at <dataRoot>/control/uninstall-handoff.json', async () => {
        const dataRoot = mkdtempSync(join(tmpdir(), 'marker-test-'));
        const result = await writeUninstallHandoffMarker(dataRoot, {
            targetSessionId: 1,
            launcherPath: 'C:\\Program Files\\WsScrcpyWeb\\current\\ws-scrcpy-web-launcher.exe',
            launcherArgs: ['--local-takeover'],
        });
        expect(result.ok).toBe(true);
        const path = join(dataRoot, 'control', 'uninstall-handoff.json');
        expect(existsSync(path)).toBe(true);
        const body = JSON.parse(readFileSync(path, 'utf8'));
        expect(body.verb).toBe('uninstall-service');
        expect(body.targetSessionId).toBe(1);
        expect(body.launcherPath).toBe('C:\\Program Files\\WsScrcpyWeb\\current\\ws-scrcpy-web-launcher.exe');
        expect(body.launcherArgs).toEqual(['--local-takeover']);
        expect(body.writtenAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('overwrites an existing marker', async () => {
        const dataRoot = mkdtempSync(join(tmpdir(), 'marker-test-'));
        await writeUninstallHandoffMarker(dataRoot, {
            targetSessionId: 1, launcherPath: 'a.exe', launcherArgs: [],
        });
        await writeUninstallHandoffMarker(dataRoot, {
            targetSessionId: 2, launcherPath: 'a.exe', launcherArgs: [],
        });
        const path = join(dataRoot, 'control', 'uninstall-handoff.json');
        const body = JSON.parse(readFileSync(path, 'utf8'));
        expect(body.targetSessionId).toBe(2);
    });

    it('accepts null targetSessionId for "any session"', async () => {
        const dataRoot = mkdtempSync(join(tmpdir(), 'marker-test-'));
        const result = await writeUninstallHandoffMarker(dataRoot, {
            targetSessionId: null, launcherPath: 'a.exe', launcherArgs: [],
        });
        expect(result.ok).toBe(true);
        const path = join(dataRoot, 'control', 'uninstall-handoff.json');
        const body = JSON.parse(readFileSync(path, 'utf8'));
        expect(body.targetSessionId).toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/util/__tests__/control-marker.test.ts`
Expected: import error — module does not exist.

- [ ] **Step 3: Implement `control-marker.ts`**

Create `src/server/util/control-marker.ts`:
```ts
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const CONTROL_DIR = 'control';
export const UNINSTALL_HANDOFF_FILENAME = 'uninstall-handoff.json';

export interface UninstallHandoffMarkerInput {
    targetSessionId: number | null;
    launcherPath: string;
    launcherArgs: string[];
}

export type WriteMarkerResult =
    | { ok: true }
    | { ok: false; errorMessage: string };

/**
 * Write the uninstall-handoff marker atomically under
 * `<dataRoot>/control/uninstall-handoff.json`. Tray helpers in matching
 * sessions detect the marker, spawn the launcher, and delete the marker.
 */
export async function writeUninstallHandoffMarker(
    dataRoot: string,
    input: UninstallHandoffMarkerInput,
): Promise<WriteMarkerResult> {
    const dir = join(dataRoot, CONTROL_DIR);
    const finalPath = join(dir, UNINSTALL_HANDOFF_FILENAME);
    const tmpPath = `${finalPath}.tmp`;
    const body = JSON.stringify({
        verb: 'uninstall-service',
        targetSessionId: input.targetSessionId,
        launcherPath: input.launcherPath,
        launcherArgs: input.launcherArgs,
        writtenAt: new Date().toISOString(),
    }, null, 2);
    try {
        await mkdir(dir, { recursive: true });
        await writeFile(tmpPath, body, 'utf8');
        await rename(tmpPath, finalPath);
        return { ok: true };
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { ok: false, errorMessage: message };
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/util/__tests__/control-marker.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/util/control-marker.ts src/server/util/__tests__/control-marker.test.ts; git commit -m "feat(server): add writeUninstallHandoffMarker atomic helper"
```

---

## Phase 4 — Tray helper integration

### Task 10: Spawn poller thread before tray loop

**Files:**
- Modify: `tray/src/main.rs`

- [ ] **Step 1: Read existing tray/src/main.rs** to confirm the location for the thread spawn (immediately before `common::tray::run(...)` at line 39).

- [ ] **Step 2: Implement the thread spawn**

In `tray/src/main.rs`, between the `let port = ...` line and the `let open_url = ...` line, add:
```rust
    // Theory D: poll <dataRoot>/control/uninstall-handoff.json on a background
    // thread so service-Node can hand off uninstall flows without WTS APIs.
    // Runs for the lifetime of the tray helper; thread is killed on exit.
    {
        let data_root = config_dir.clone();
        // SAFETY: WTSGetActiveConsoleSessionId has no preconditions on
        // Windows; on non-Windows we don't compile this branch.
        #[cfg(windows)]
        let own_session = unsafe {
            windows_sys::Win32::System::RemoteDesktop::WTSGetActiveConsoleSessionId()
        };
        #[cfg(not(windows))]
        let own_session: u32 = 0;
        std::thread::spawn(move || {
            common::control_marker::poll_for_handoff(
                &data_root,
                own_session,
                std::time::Duration::from_millis(750),
            );
        });
    }
```

If `windows-sys` isn't already a tray dep, add to `tray/Cargo.toml`:
```toml
[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.59", features = ["Win32_System_RemoteDesktop"] }
```

- [ ] **Step 3: Verify build**

Run: `cargo build -p ws-scrcpy-web-tray`
Expected: clean build.

- [ ] **Step 4: Run all common tests once more to confirm no regression**

Run: `cargo test --workspace`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add tray/src/main.rs tray/Cargo.toml tray/Cargo.lock 2>/dev/null; git commit -m "feat(tray): spawn control_marker poller thread before tray loop"
```

---

## Phase 5 — ServiceApi switch

### Task 11: Replace `runElevated('spawn-user-launcher', ...)` with marker write

**Files:**
- Modify: `src/server/api/ServiceApi.ts:480-488`

- [ ] **Step 1: Locate the existing block** in `handoffUninstallToUserSession` (read lines 460–520 for context).

- [ ] **Step 2: Add imports at top of file**

In `src/server/api/ServiceApi.ts`, near the existing imports, add:
```ts
import { writeUninstallHandoffMarker } from '../util/control-marker';
import { resolveActiveSessionId } from '../util/active-session';
```

- [ ] **Step 3: Replace the spawn block**

Find the existing block (currently around line 480):
```ts
        const spawnResult = await runElevated('spawn-user-launcher', {
            launcherPath,
            launcherArgs: ['--local-takeover'],
        });
        if (!spawnResult.ok) {
            log.warn(`uninstall handoff: spawn-user-launcher failed: ${spawnResult.errorMessage ?? '(no message)'}`);
            return false;
        }
```

Replace with:
```ts
        // Theory D: write a control marker instead of cross-session WTS spawn.
        // The user-session tray helper polls this path and spawns the launcher
        // natively in its own session. Falls back to direct uninstall if
        // discover() can't find a launcher within the timeout.
        const sessionResult = await resolveActiveSessionId(launcherPath);
        const targetSessionId = sessionResult.ok ? sessionResult.sessionId : null;
        if (!sessionResult.ok) {
            log.warn(`uninstall handoff: could not resolve active session, marker will accept any tray helper: ${sessionResult.errorMessage}`);
        }
        const writeResult = await writeUninstallHandoffMarker(this.dataRoot, {
            targetSessionId,
            launcherPath,
            launcherArgs: ['--local-takeover'],
        });
        if (!writeResult.ok) {
            log.warn(`uninstall handoff: marker write failed: ${writeResult.errorMessage}`);
            return false;
        }
        log.info(`uninstall handoff: marker written (targetSessionId=${targetSessionId ?? 'any'})`);
```

(The reference to `this.dataRoot` requires that ServiceApi already has access to the data root. If it doesn't, locate where `<dataRoot>` is computed elsewhere in this file — search for `dataRoot`, `data_root`, or `programDataPath` — and use that path. If still missing, add a constructor param.)

- [ ] **Step 4: Verify TS compile**

Run: `npx tsc --noEmit`
Expected: no errors related to the new imports / call sites.

- [ ] **Step 5: Run TS unit tests**

Run: `npx vitest run`
Expected: all tests pass (including the new util tests).

- [ ] **Step 6: Commit**

```bash
git add src/server/api/ServiceApi.ts; git commit -m "feat(server): hand off service uninstall via control marker (Theory D)"
```

---

## Phase 6 — Build + manual VM smoke test

### Task 12: Full workspace build + test pass

- [ ] **Step 1: Run the full validation gates**

Run sequentially:
```bash
npx tsc --noEmit
npx vitest run
cargo test --workspace
cargo build --release --workspace
npm run build
```

Expected: all green. If anything fails, fix in place — don't ship a half-broken Theory D.

- [ ] **Step 2: Commit any tweaks needed**

If fixes were required, commit them with a descriptive message.

---

### Task 13: Manual VM smoke test (post-build)

This task does NOT run in CI. After local builds pass, do these steps on a fresh-VM-installed beta:

- [ ] **Step 1: Build a local MSI**

Run from repo root:
```bash
rm -rf publish Releases
node scripts/fetch-servy.mjs
node scripts/fetch-node.mjs
node scripts/stage-publish.mjs
vpk pack --packId WsScrcpyWeb --packVersion 0.1.24-beta.X --packDir publish --mainExe ws-scrcpy-web-launcher.exe --packTitle "ws-scrcpy-web" --packAuthors "ws-scrcpy-web contributors" --channel stable --icon assets/tray-icon.ico --msi --instLocation PerMachine -o Releases
```

- [ ] **Step 2: Install on Win11 VM** with admin user account.

- [ ] **Step 3: Reproduce the Theory D test path**:
  1. Open the app at `http://localhost:8000` (or whichever port the launcher binds).
  2. Settings → Service section → click **install?**.
  3. Wait for the service to register (`servy install` completes, page resumes).
  4. Refresh the page; verify Service section now shows `running — uninstall?`.
  5. Click **uninstall?**.
  6. **Expect**: the modal redirects within ~3–5s to the user-session launcher's port (URL changes), uninstall completes, local tray icon appears.
  7. **Failure mode**: if it hangs ~30s and falls through to "couldn't reach server", check `<ProgramData>\WsScrcpyWeb\logs\` for evidence:
     - `<ProgramData>\WsScrcpyWeb\control\uninstall-handoff.json` should exist briefly
     - `ws-scrcpy-web.log` (service) should contain `uninstall handoff: marker written`
     - The user-session launcher should have a fresh log entry ~750ms–2s after the marker timestamp

- [ ] **Step 4: Document the result** in the project todo file under §1c.

---

## Out of scope for this plan

- Cleanup of `launcher/src/user_session_spawn.rs` and the `spawn-user-launcher` dispatch in `elevated_runner.rs`. Source kept; not invoked. Delete in a later sweep once Theory D is stable in production.
- §1c bug 2 (multi-user port drift in service mode) — separate diagnostic session.
- §1c bug B (Path B fallback doesn't restore tray) — only triggers when Theory D's fallback runs, which should be rare. Deferred.

---

## Acceptance

A v0.1.24-beta MSI installs cleanly on a fresh Win11 VM, the user can install the service, uninstall the service, and arrive on a working user-mode launcher with tray — all without manually relaunching the launcher exe. `launcher.log` shows the user-session launcher booting via `--local-takeover` after a marker pickup, NOT via WTS handoff. `cargo test --workspace` and `npx vitest run` are green.
