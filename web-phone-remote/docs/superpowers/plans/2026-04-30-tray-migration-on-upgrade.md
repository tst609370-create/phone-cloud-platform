# Tray Migration on Upgrade Implementation Plan (v0.1.25-beta.2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Make the v0.1.25-beta.1 HKLM\Run migration work for upgrades from v0.1.24 (currently it only fires on fresh service installs) and prevent duplicate tray icons during the transitional state.

**Architecture:** Three independent self-heals: (A) service-mode launcher writes HKLM under LocalSystem; (B) tray helper acquires per-session mutex; (C) mutex winner cleans stale HKCU\Run. All idempotent.

**Tech Stack:** Rust (`launcher/`, `tray/` crates), `windows-rs` (already in workspace), `reg.exe` shellouts (existing pattern).

**Spec:** `docs/superpowers/specs/2026-04-30-tray-migration-on-upgrade-design.md`

---

## File Structure

**Files modified:**
- `tray/src/main.rs` — call mutex acquire + HKCU cleanup at startup.
- `launcher/src/elevated_runner.rs` — new `migrate_tray_run_key_for_service` + helper to make `register_tray_run_key` accessible to it.
- `launcher/src/supervisor.rs` — call migration helper at service-mode startup.

**Files created:**
- `tray/src/single_instance.rs` — per-session mutex module, mirroring `launcher/src/single_instance.rs` pattern but simpler.

---

## Task A: Per-session mutex module for the tray helper

**Files:**
- Create: `tray/src/single_instance.rs`
- Modify: `tray/src/main.rs` (add `mod single_instance;` declaration)

- [ ] **Step 1: Create the new module file**

Write `tray/src/single_instance.rs` with the following content (mirrors the launcher version, simplified — no User/Admin elevation segregation):

```rust
// Per-session single-instance guard for the standalone tray helper.
//
// The tray helper can be spawned at logon by both HKLM\...\Run and
// HKCU\...\Run entries (transitional state during the v0.1.24 → v0.1.25
// migration where both registry values may exist for the installing
// admin). Without a single-instance gate, two tray icons appear in the
// same session.
//
// We use a Windows named mutex in the `Local\` namespace so the gate is
// auto-scoped per logon session: User A and User B logged in concurrently
// each have their own mutex and don't fight each other.
//
// Implementation mirrors `launcher/src/single_instance.rs` but is simpler:
// no User/Admin suffix, since there is no "elevated tray" workflow that
// the launcher's elevation segregation supports.

use anyhow::Result;

#[cfg(windows)]
mod imp {
    use anyhow::Result;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    fn to_wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    /// RAII handle that releases the named mutex on drop.
    pub struct InstanceGuard {
        handle: windows::Win32::Foundation::HANDLE,
    }

    impl Drop for InstanceGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(self.handle);
            }
        }
    }

    /// Try to acquire the per-session mutex. Returns:
    ///   - Ok(Some(guard)) when this process is the first / only instance.
    ///   - Ok(None) when another instance already holds the mutex; caller
    ///     should exit silently with status 0.
    ///   - Err(e) on rare CreateMutexW failure; caller should log + proceed
    ///     without the guard rather than fail startup.
    pub fn acquire(name: &str) -> Result<Option<InstanceGuard>> {
        use windows::Win32::Foundation::{ERROR_ALREADY_EXISTS, GetLastError};
        use windows::Win32::System::Threading::CreateMutexW;
        use windows::core::PCWSTR;

        let wide = to_wide(name);
        let handle = unsafe {
            CreateMutexW(None, false, PCWSTR::from_raw(wide.as_ptr()))?
        };
        let last = unsafe { GetLastError() };
        if last == ERROR_ALREADY_EXISTS {
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(handle);
            }
            return Ok(None);
        }
        Ok(Some(InstanceGuard { handle }))
    }
}

#[cfg(not(windows))]
mod imp {
    use anyhow::Result;

    /// Stub on non-Windows. The standalone tray helper is Windows-only
    /// today (service mode is Windows-only); this stub keeps the call
    /// site's signature stable on Linux builds.
    pub struct InstanceGuard;

    pub fn acquire(_name: &str) -> Result<Option<InstanceGuard>> {
        Ok(Some(InstanceGuard))
    }
}

pub use imp::acquire;
#[allow(unused_imports)]
pub use imp::InstanceGuard;

/// Canonical mutex name. `Local\` prefix auto-scopes per logon session.
pub const MUTEX_NAME: &str = r"Local\WsScrcpyWebTray-SingleInstance";

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn unique_name() -> String {
        format!(
            r"Local\WsScrcpyWebTray-Test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    }

    #[test]
    fn acquire_grants_first_caller() {
        let name = unique_name();
        let guard = acquire(&name).unwrap();
        assert!(guard.is_some(), "first acquire should succeed");
    }

    #[test]
    fn acquire_denies_second_caller_while_first_is_held() {
        let name = unique_name();
        let first = acquire(&name).unwrap().expect("first acquire");
        let second = acquire(&name).unwrap();
        assert!(second.is_none(), "second acquire should see ERROR_ALREADY_EXISTS");
        drop(first);
    }

    #[test]
    fn acquire_succeeds_again_after_first_drops() {
        let name = unique_name();
        {
            let _g = acquire(&name).unwrap().expect("first acquire");
        }
        let again = acquire(&name).unwrap();
        assert!(again.is_some(), "acquire after drop should succeed");
    }
}
```

- [ ] **Step 2: Run the new tests**

```bash
cargo test --manifest-path tray/Cargo.toml single_instance
```

Expected: 3 passing tests. If any fail, surface and stop.

- [ ] **Step 3: Commit**

```bash
git add tray/src/single_instance.rs
git commit -m "feat(tray): add per-session single-instance mutex module

New tray/src/single_instance.rs mirrors launcher/src/single_instance.rs
but simplified for the standalone tray helper context (no User/Admin
elevation segregation — there is no elevated-tray workflow). Uses
Windows named mutex in Local\\ namespace for per-session scoping so
multiple users logged in concurrently each get their own mutex.

Will be wired into tray/src/main.rs in the next commit. Resolves
half of todo §1c bug 2 prep work for v0.1.25-beta.2."
```

(Note: the file is added but not yet referenced by `mod single_instance;` — Cargo will warn about the orphan file. That's fine for one commit; Task B wires it in. If your build setup hard-errors on orphan modules, add `mod single_instance;` to `tray/src/main.rs` in this commit and remove the warning suppression in Task B.)

---

## Task B: Wire mutex into tray/src/main.rs + add HKCU cleanup

**Files:**
- Modify: `tray/src/main.rs`

- [ ] **Step 1: Add module declaration**

At the top of `tray/src/main.rs`, after the existing `#![cfg_attr(...)]` line and before the `use std::env;` line, add:

```rust
mod single_instance;
```

- [ ] **Step 2: Add the HKCU cleanup function**

In `tray/src/main.rs`, add a new private function before `fn main()`:

```rust
/// Best-effort delete of the pre-v0.1.25 HKCU\...\Run\WsScrcpyWebTray value
/// for the current user. v0.1.24 wrote this from elevated install context,
/// which only landed in the installing admin's hive — so for non-admin users
/// this is always a no-op. For the original installing admin, this removes
/// the stale registration that would otherwise spawn a duplicate tray
/// alongside the new HKLM-Run-spawned one.
///
/// Returns success on exit code 0 (deleted) AND exit code 1 (not present,
/// or other recoverable failure — see classify_reg_delete_outcome rationale
/// in launcher/src/elevated_runner.rs). Other exit codes propagate stderr.
#[cfg(windows)]
fn cleanup_stale_hkcu_run_value() -> Result<()> {
    use std::process::Command;

    let out = Command::new("reg.exe")
        .args([
            "delete",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            "WsScrcpyWebTray",
            "/f",
        ])
        .output()
        .context("reg.exe delete HKCU Run-key")?;

    match out.status.code() {
        Some(0) | Some(1) => Ok(()),
        _ => {
            anyhow::bail!(
                "reg.exe exited with {:?}; stderr: {}",
                out.status.code(),
                String::from_utf8_lossy(&out.stderr)
            );
        }
    }
}

#[cfg(not(windows))]
fn cleanup_stale_hkcu_run_value() -> Result<()> {
    Ok(())
}
```

- [ ] **Step 3: Wire into main()**

At the very top of `fn main()`, BEFORE any other logic (config resolution, URL provider, etc.), add:

```rust
fn main() -> Result<()> {
    // Per-session single-instance gate. If another tray helper is already
    // running in this logon session, exit silently. This handles the
    // transitional state where both HKLM\Run (new) and HKCU\Run (stale
    // from v0.1.24 install) point at the tray exe and both fire at logon.
    let _instance_guard = match single_instance::acquire(single_instance::MUTEX_NAME) {
        Ok(Some(guard)) => guard,
        Ok(None) => {
            // Another tray already running. Exit silently.
            return Ok(());
        }
        Err(e) => {
            // CreateMutexW failed (rare). Log and proceed without the guard
            // rather than block startup.
            eprintln!("tray: single-instance acquire failed: {e:?}; continuing without guard");
            // Continue with a stub guard via match-fallthrough — easiest
            // to just rebuild the value below.
            // (Implementation note: the launcher's pattern uses a None
            // sentinel; we keep this branch path logical-only since the
            // following code doesn't reference the guard.)
            return run_main_without_guard();
        }
    };

    run_main_without_guard()
}
```

Wait — that's awkward. Refactor: extract the existing main body into a helper function. New shape:

```rust
fn main() -> Result<()> {
    // Per-session single-instance gate.
    let _instance_guard = match single_instance::acquire(single_instance::MUTEX_NAME) {
        Ok(Some(guard)) => Some(guard),
        Ok(None) => return Ok(()), // duplicate; exit silently
        Err(e) => {
            eprintln!("tray: single-instance acquire failed: {e:?}; continuing without guard");
            None
        }
    };

    // Best-effort cleanup of stale HKCU\Run from the v0.1.24 era.
    if let Err(e) = cleanup_stale_hkcu_run_value() {
        eprintln!("tray: HKCU\\Run cleanup failed (non-fatal): {e:?}");
    }

    run_tray()
}

fn run_tray() -> Result<()> {
    // <ALL the existing main() body content lives here unchanged>
}
```

Apply this refactor: rename the current `fn main() -> Result<()>` body to `fn run_tray() -> Result<()>`, then write the new compact `fn main()` that does the gate + cleanup + delegates.

- [ ] **Step 4: Build to confirm compile**

```bash
cargo build --manifest-path tray/Cargo.toml
```

Expected: clean build.

- [ ] **Step 5: Run tray tests + workspace tests**

```bash
cargo test --manifest-path tray/Cargo.toml
cargo test --workspace
```

Expected: all tests pass. The new tests from Task A run as part of `cargo test --manifest-path tray/Cargo.toml`.

- [ ] **Step 6: Run clippy**

```bash
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add tray/src/main.rs
git commit -m "feat(tray): per-session single-instance gate + stale HKCU\\Run cleanup

Tray helper now acquires Local\\WsScrcpyWebTray-SingleInstance mutex
at startup. If another instance already holds it (typical in the
v0.1.24 → v0.1.25 transitional state where both HKLM\\Run and
HKCU\\Run point at the tray exe and both fire at logon), exit silently.
The winning instance also best-effort deletes HKCU\\...\\Run\\WsScrcpyWebTray
to remove the stale v0.1.24 registration. No-op for users who never
had HKCU\\Run written (i.e., everyone except the original installing
admin).

Resolves the duplicate-tray issue admins saw post-v0.1.25-beta.1
manual HKLM write, and self-heals the HKCU dust trail on first admin
logon after upgrade."
```

---

## Task C: Service-mode launcher writes HKLM at startup

**Files:**
- Modify: `launcher/src/elevated_runner.rs` — add `migrate_tray_run_key_for_service`.
- Modify: `launcher/src/supervisor.rs` — call the new function early in `run()`.

- [ ] **Step 1: Add the migration helper to elevated_runner.rs**

Open `launcher/src/elevated_runner.rs`. Find the existing `register_tray_run_key` function (around line 393 after the prior batch's changes). Add a new public function AFTER it (before `unregister_tray_run_key`):

```rust
/// Service-mode startup migration: ensure HKLM\...\Run\WsScrcpyWebTray
/// points at the tray helper exe. Idempotent — fast-paths when the value
/// is already correct, only writes when missing or pointing at a wrong
/// path.
///
/// Called from `supervisor::run` when the launcher is starting in service
/// mode. The launcher under Servy runs as LocalSystem, which can write
/// HKLM with no UAC prompt.
///
/// `install_root` is the resolved installation root; the tray helper
/// is expected at `<install_root>/current/ws-scrcpy-web-tray.exe`.
///
/// Best-effort: returns `Ok(())` on success or "no migration needed";
/// returns `Err` only on actual failure (logged by caller, not fatal).
pub fn migrate_tray_run_key_for_service(install_root: &std::path::Path) -> Result<(), String> {
    let tray_path = install_root
        .join("current")
        .join("ws-scrcpy-web-tray.exe");
    if !tray_path.exists() {
        return Err(format!(
            "tray helper not found at expected path {tray_path:?}; skipping HKLM migration"
        ));
    }
    let tray_path_str = tray_path
        .to_str()
        .ok_or_else(|| format!("tray path {tray_path:?} is not valid UTF-8"))?;

    // Fast path: read the current value via reg.exe query and short-circuit
    // when it's already correct.
    let query = Command::new("reg.exe")
        .args([
            "query",
            TRAY_RUN_KEY,
            "/v",
            TRAY_RUN_VALUE,
        ])
        .output()
        .map_err(|e| format!("reg.exe query failed to spawn: {e}"))?;

    if query.status.success() {
        // Output looks like:
        //   HKEY_LOCAL_MACHINE\Software\...\Run
        //       WsScrcpyWebTray    REG_SZ    C:\...\ws-scrcpy-web-tray.exe
        // We only need to confirm the trailing path matches.
        let stdout = String::from_utf8_lossy(&query.stdout);
        if stdout.contains(tray_path_str) {
            // Already migrated; no-op.
            return Ok(());
        }
        // Value present but path differs — fall through to overwrite.
    }
    // Either the value wasn't present (query exit != 0) or the path differs —
    // either way, write it.
    register_tray_run_key(tray_path_str)
}
```

Note the function calls `register_tray_run_key`, which is currently private (`fn`). Check its current visibility — if it's `fn`, change it to `fn` (still private to the module since both functions are in the same file) — no signature change needed. The new function can call it directly.

- [ ] **Step 2: Wire the call into supervisor.rs**

Read `launcher/src/supervisor.rs`. Find `pub fn run` (the main supervisor entry). Find the point where service-mode is detected and the supervisor knows it's running under Servy. Add the migration call there, BEFORE the Node spawn.

If you can't immediately find the right location, search for `is_service_mode` calls or service-mode-gated branches. The migration call should be:

```rust
// Service-mode tray Run-key migration. Idempotent — fast-paths when
// already correct. LocalSystem token has the privileges to write HKLM
// without UAC.
if let Err(e) = crate::elevated_runner::migrate_tray_run_key_for_service(install_root) {
    log::error(&format!("supervisor: tray HKLM migration: {e}"));
} else {
    log::info("supervisor: tray HKLM migration check complete");
}
```

The exact placement needs to satisfy: (a) service mode confirmed, (b) `install_root` available in scope, (c) before Node spawn (so a long-running Node startup doesn't delay migration). If install_root is named differently in supervisor.rs (e.g., `app_root` or similar), use the local name.

- [ ] **Step 3: Build the workspace**

```bash
cargo build --workspace
```

Expected: clean build.

- [ ] **Step 4: Run launcher tests**

```bash
cargo test --manifest-path launcher/Cargo.toml
```

Expected: all tests pass. The migration function isn't unit-testable without a real registry, so coverage relies on Task 5's manual VM verification.

- [ ] **Step 5: Run clippy**

```bash
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add launcher/src/elevated_runner.rs launcher/src/supervisor.rs
git commit -m "feat(launcher): service-mode self-heal of HKLM\\Run\\WsScrcpyWebTray

Adds migrate_tray_run_key_for_service called from supervisor::run when
launching in service mode. LocalSystem context can write HKLM without
UAC. Idempotent — reads current value first and short-circuits when
the registration already points at the right tray exe.

This is the load-bearing fix for v0.1.25-beta.1's incomplete migration
coverage: the original fix only fired inside install_service (live
'click install service' UI path). The Velopack on_updated hook just
restarts the service via servy-cli — it never touched tray
registration, so v0.1.24 → v0.1.25-beta.1 upgrades left HKLM\\Run
unwritten and non-admin users got no tray at logon.

After v0.1.25-beta.2 ships, the FIRST service restart triggered by
on_updated (or any subsequent service start) self-heals the HKLM
registration."
```

---

## Task D: CHANGELOG + release prep

**Files:**
- Modify: `CHANGELOG.md` — add Unreleased entry summarizing the fix.

- [ ] **Step 1: Update CHANGELOG.md**

Open `CHANGELOG.md`. Under `## [Unreleased]`, add (or extend) a `### Fixed` section:

```markdown
### Fixed

- **Service-mode tray helper now migrates correctly on upgrade from v0.1.24** — v0.1.25-beta.1 only wrote `HKLM\...\Run\WsScrcpyWebTray` from the live "install service" UI path, which doesn't fire on Velopack upgrade, so v0.1.24 → v0.1.25-beta.1 installs left the new HKLM key unwritten and non-admin users got no tray icon at logon. v0.1.25-beta.2 self-heals on every service start (LocalSystem context writes HKLM idempotently) so upgrades migrate automatically.
- **No more duplicate tray icons in admin's session post-migration** — added a per-session single-instance mutex (`Local\WsScrcpyWebTray-SingleInstance`) to the standalone tray helper. The mutex winner also best-effort deletes the stale HKCU\Run\WsScrcpyWebTray value left over from v0.1.24, so subsequent logons spawn exactly one tray.
```

(If the Unreleased section already has the v0.1.25-beta.1 → stable HKLM-tray entry from the prior batch, MERGE this into the same `### Fixed` block. Don't duplicate.)

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): tray migration fix lands in v0.1.25-beta.2"
```

- [ ] **Step 3: Hand off to release prep**

The release cut itself (npm run version:bump, Cargo.lock, tag, push) lives outside this plan — driven by the controller after all per-task reviews pass. The bump-version.mjs fix from the minor-tweaks batch should now correctly relocate the Unreleased entry to a new `[0.1.25-beta.2]` section without leaving a doubled blank.

---

## Self-Review

**Spec coverage:**
- Goal 1 (auto-migration on upgrade) → Task C (Path A).
- Goal 2 (no duplicate trays ever) → Task A + B (Path B + C).
- Goal 3 (stale HKCU cleanup) → Task B (the cleanup function).
- Goal 4 (idempotent self-heal) → Task C fast path + Task A mutex semantics + Task B `let _ =` cleanup.
- Goal 5 (no UAC) → Task C uses LocalSystem service context; Tasks A+B run in user context with no privilege escalation.

**Placeholder scan:** No "TBD" / "TODO later". Every step has the actual code + commands + commit message.

**Type/name consistency:**
- Function name `migrate_tray_run_key_for_service` — used in Task C Step 1 (definition) + Task C Step 2 (call site). Consistent.
- Function name `cleanup_stale_hkcu_run_value` (in tray/main.rs, Task B) is intentionally distinct from `cleanup_stale_hkcu_tray_run_key` (in launcher/elevated_runner.rs from beta.1 work) — different modules, similar shape, slightly different name to keep grep clear about which file.
- Mutex name `Local\WsScrcpyWebTray-SingleInstance` — used in Task A constant + Task B call. Consistent.
- `MUTEX_NAME` constant exposed from `tray::single_instance::MUTEX_NAME` — used in Task B Step 3.

No issues found.

---

## Execution Handoff

After completing Tasks A–D, controller dispatches a final whole-branch reviewer pass, then runs release prep (version bump, tag, push) outside this plan.
