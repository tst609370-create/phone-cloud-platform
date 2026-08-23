# Tray auto-start: machine-wide (HKLM\Run) — design

**Date:** 2026-04-30
**Project:** ws-scrcpy-web
**Status:** Shipped in v0.1.25-beta.1
**Motivates:** §1c bug 2 (multi-user port drift) reproduction; closes a coverage gap surfaced during v0.1.25 testing

## Problem

In service mode, the standalone tray helper (`ws-scrcpy-web-tray.exe`) is registered for auto-start at logon via `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. The registration is performed inside the elevated install hook (`launcher/src/elevated_runner.rs::register_tray_run_key`, called from `install_service`), which means `HKCU` resolves to the **installing admin's** registry hive only.

Consequences:
- Only the installing admin sees a tray icon at logon.
- All other users on the machine — even though they share the machine-wide service backend — get no tray UX surface at all.
- Multi-user scenarios (port-drift testing, RDP boxes, fast-user-switching) cannot exercise per-user tray behavior, blocking reproduction of related bugs.

The tray helper itself is per-user-session-clean: it reads its config from the machine-wide `<dataRoot>` (`%PROGRAMDATA%\WsScrcpyWeb`), re-reads `config.json::webPort` on every click, and posts to `localhost:<port>`. There are no install-admin-only dependencies inside the tray helper. The bug is entirely in the auto-start registration mechanism.

## Goals

1. Every user logging into a machine where ws-scrcpy-web is installed in service mode receives a tray icon at logon, running under their own user token.
2. Existing v0.1.24-era installs that have stale `HKCU\...\Run\WsScrcpyWebTray` values for the installing admin are cleaned up on upgrade.
3. Uninstall removes the auto-start registration machine-wide.
4. Per-user opt-out remains available via the standard Windows "Startup apps" UI (Task Manager → Startup apps tab) for users who don't want the tray.
5. No changes to the tray helper binary itself or to local-mode (non-service) auto-spawn.

## Non-goals

- Cross-session tray-killing during uninstall. The existing `taskkill /F /IM ws-scrcpy-web-tray.exe` only reaches the elevated session's processes; trays in other users' sessions remain orphaned until those users log out. The orphan is benign (HTTP POST to a dead port fails fire-and-forget), and fixing it requires WTS session enumeration which is out of scope for this fix.
- Cross-user `HKCU` cleanup beyond the installing admin's hive. Other users never had the value written to begin with; their hives are already correct.

## Approach

Switch the auto-start registration from `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` to `HKLM\Software\Microsoft\Windows\CurrentVersion\Run`. Windows runs `HKLM\...\Run` entries at every user's logon under that user's own token, which is exactly the desired behavior. The install hook already runs elevated, so writing to HKLM requires no additional privilege escalation.

Add a one-shot best-effort cleanup of the installing admin's stale `HKCU\...\Run\WsScrcpyWebTray` on install, to handle in-place upgrades from v0.1.24.

## File changes

**`launcher/src/elevated_runner.rs`:**

```rust
// Before
const TRAY_RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

// After
const TRAY_RUN_KEY: &str = r"HKLM\Software\Microsoft\Windows\CurrentVersion\Run";
const STALE_HKCU_TRAY_RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
```

- `register_tray_run_key(tray_path)` — unchanged logic; just writes to HKLM by virtue of the constant flip.
- `unregister_tray_run_key()` — unchanged logic; deletes from HKLM by virtue of the constant flip.
- **New:** `cleanup_stale_hkcu_tray_run_key()` — `reg.exe delete HKCU\...\Run /v WsScrcpyWebTray /f`, with the same "value-not-found is success" semantics as `unregister_tray_run_key`. Called from `install_service` after `register_tray_run_key` returns successfully.

**No changes to:**
- `tray/src/main.rs` — has no HKCU dependencies.
- `launcher/src/tray.rs` — local-mode tray; not affected.
- `common/src/tray.rs` — shared tray loop; not affected.
- `launcher/src/hooks.rs::on_uninstall` — already calls `unregister_tray_run_key`; same call site, now hits HKLM.

## Install / uninstall / upgrade flow

### Fresh install (new HKLM-aware version, no prior install)

1. Elevated `install_service()` runs.
2. servy-cli registers and starts the Windows service.
3. `register_tray_run_key()` writes `HKLM\...\Run\WsScrcpyWebTray = <path-to-tray.exe>`.
4. `cleanup_stale_hkcu_tray_run_key()` runs — finds nothing, no-ops.
5. Existing `Command::new(tray).spawn()` — tray appears in admin's elevated session immediately.
6. Any other user logging in afterward: Windows reads `HKLM\...\Run` at logon → tray spawns under their token.

### Upgrade from v0.1.24 (HKCU-era) to new version

1. Velopack stages the new version, runs the install hook.
2. Same flow as fresh install, but step 4 finds the stale `HKCU\...\Run\WsScrcpyWebTray` for the upgrading admin and deletes it.
3. Net result: admin's HKCU is clean, HKLM has the new value, all users get a tray on their next logon.

### Uninstall (MSI uninstall via `hooks::on_uninstall` and explicit in-app uninstall via `uninstall_service`)

1. Service stop and servy uninstall (unchanged).
2. `unregister_tray_run_key()` deletes from HKLM.
3. `taskkill /F /IM ws-scrcpy-web-tray.exe` (existing) kills tray instances reachable from the elevated session. Trays in other users' sessions remain orphaned until those users log out — see Non-goals.

### Mode swap (service → local) without uninstall

`unregister_tray_run_key()` is called on service teardown when switching modes (existing flow). HKLM gets cleared. Local-mode tray is launcher-internal (separate thread, no Run key). Correct behavior preserved.

## Testing strategy

### Unit tests (`launcher/src/elevated_runner.rs`)

- **New:** `tray_run_key_targets_hklm` — assert `TRAY_RUN_KEY.starts_with("HKLM\\")`. Cheap regression guard against accidental flips back to HKCU.
- Existing `handle()` / unknown-command / args-parsing tests — unchanged.
- `register_tray_run_key`, `unregister_tray_run_key`, `cleanup_stale_hkcu_tray_run_key` are not unit-testable without registry side effects (they shell out to `reg.exe`). Live-registry tests are intentionally excluded — too flaky, pollutes CI hosts. Coverage comes from the manual VM verification below.

### Manual VM verification (per `feedback_verify_install_on_fresh_vm.md` — required before tagging)

1. **Fresh install on multi-user Win11 VM:**
   - VM has `Admin` (installer) plus `User1` and `User2` accounts pre-created.
   - Install service-mode app as Admin → confirm tray appears in Admin's session.
   - Switch to User1 (fast user switching) → confirm tray appears within ~2s of logon.
   - Switch to User2 → same.
   - Click tray on User1, verify "Open" navigates to `localhost:<webPort>` correctly.

2. **Upgrade from v0.1.24:**
   - Install v0.1.24, switch to User1, confirm User1 has NO tray (reproduces the bug).
   - In-app update to new version (or sideload installer).
   - Switch to User1 → confirm tray now appears.
   - In Admin's `regedit`, confirm `HKCU\...\Run\WsScrcpyWebTray` is gone.
   - Confirm `HKLM\Software\Microsoft\Windows\CurrentVersion\Run\WsScrcpyWebTray` is present and points at `<installRoot>\current\ws-scrcpy-web-tray.exe`.

3. **Uninstall:**
   - With trays running in two sessions, uninstall via Add/Remove Programs as Admin.
   - Confirm Admin's tray dies (`taskkill` reaches it).
   - User1's tray will remain orphaned until they log out — verify it silently fails on click (POST to dead port, fire-and-forget) rather than crashes.
   - Confirm `HKLM\...\Run\WsScrcpyWebTray` is gone after uninstall.

4. **§1c bug 2 reproduction enabled:** with User1 now having a working tray, retry the multi-user port-drift repro that motivated this investigation.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Admin's session sees both old HKCU tray and new HKLM tray on first upgrade logon (brief double-spawn) | Single-instance gating in launcher kills the second instance; cleanup of stale HKCU on install closes the window for subsequent logons. |
| `reg.exe delete HKCU\...` fails because no stale value exists | "value not found" treated as success (mirrors existing `unregister_tray_run_key` semantics). |
| User in another session is mid-action when uninstall removes HKLM | Their tray remains running until log out (orphaned but benign — silently fails on click). Documented as Non-goal. |
| Group Policy or Restricted Groups blocks HKLM\Run writes on locked-down corporate boxes | Best-effort: if `reg.exe add` fails, log and continue (matches existing `register_tray_run_key` semantics — install does not fail). User can manually create a Startup folder shortcut as a workaround. |

## Out-of-scope follow-ups (not blocking)

- Cross-session tray killing on uninstall via WTS enumeration.
- Auditing other places we touch HKCU from elevated contexts (none found in current grep, but worth a periodic sweep).

## References

- `launcher/src/elevated_runner.rs:73,348` — current HKCU registration.
- `launcher/src/hooks.rs:349` — uninstall-flow comment referencing the HKCU cleanup.
- `tray/src/main.rs` — tray helper (no HKCU dependencies).
- `feedback_verify_install_on_fresh_vm.md` — install verification protocol.
- `feedback_velopack_permachine_lessons.md` — relevant context on PerMachine MSI install elevation behavior.
