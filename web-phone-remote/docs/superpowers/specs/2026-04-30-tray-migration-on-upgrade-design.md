# Tray migration on upgrade — design

**Date:** 2026-04-30
**Project:** ws-scrcpy-web
**Status:** Shipped in v0.1.25-beta.2
**Supersedes the migration assumptions in:** `docs/superpowers/specs/2026-04-30-tray-autostart-machine-wide-design.md`

## Problem

v0.1.25-beta.1 switched the tray helper auto-start registration from `HKCU\...\Run` to `HKLM\...\Run` so every user receives a tray icon at logon. The fix only fires inside `elevated_runner.rs::install_service()`, which runs when a user clicks **"install service"** in the live-running app's Settings UI.

It does **not** run on Velopack upgrade. The `launcher/src/hooks.rs::on_updated` hook (which fires on `--veloapp-updated`) only restarts the service via `servy-cli restart` — it never touches the tray Run-key registration.

VM verification of v0.1.25-beta.1 (2026-04-30) confirmed:
- Admin upgraded v0.1.24 → v0.1.25-beta.1.
- `HKLM\Software\Microsoft\Windows\CurrentVersion\Run\WsScrcpyWebTray` is **missing** (never written).
- `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\WsScrcpyWebTray` for the admin is **still present** from the v0.1.24 install.
- Regular user logs in → no Run-key entry visible to them → no tray icon.

The user manually wrote HKLM\Run via `reg.exe add` to verify the underlying approach works. After the manual write, regular users get a tray on logon. This confirms the HKLM-Run approach is correct; only the **migration trigger** is missing.

A second issue surfaced: after the manual HKLM write while the admin's stale HKCU is still present, the admin sees **two tray icons** at next logon — one spawned from each Run-key entry. The standalone tray helper (`tray/src/main.rs`) has no per-session single-instance gate, so two registry entries → two processes → two icons. The v0.1.25-beta.1 spec assumed launcher single-instance gating would absorb duplicates; that assumption was wrong (the launcher's `single_instance.rs` guards the launcher process, not the standalone tray helper).

## Goals

1. **Upgrade migration works automatically.** Any v0.1.24 → v0.1.25+ install where the user is in service mode should end up with `HKLM\Run\WsScrcpyWebTray` written, without requiring user action.
2. **No duplicate trays in any session, ever.** Even if both HKLM\Run and HKCU\Run point at the tray exe (transitional state on first admin logon post-migration), the user sees exactly one tray.
3. **Stale HKCU\Run is cleaned up** for the original installing admin, so the duplicate-spawn condition self-resolves after one admin logon.
4. **Idempotent and self-healing.** All migration logic is safe to run on every service start / every tray launch — fresh installs no-op, partially-migrated installs heal forward.
5. **No new privilege prompts.** Migration must complete without UAC.

## Non-goals

- Migrating non-admin users' HKCU values. Only the original installing admin had HKCU written; all other users' HKCU is already empty.
- Centralized cross-process orchestration. Each process self-heals what it can reach in its own privilege/identity context.
- Backporting the migration to local-mode (non-service) installs. Local mode never registered a Run-key, so there's nothing to migrate.

## Approach

Three independent, idempotent self-heals running in three different privilege contexts. Together they cover every reachable migration path.

### Path A — Service-mode launcher writes HKLM (LocalSystem context)

When Servy starts the WsScrcpyWeb service, it spawns `launcher.exe` under LocalSystem. LocalSystem can write HKLM with no UAC prompt. At service-mode startup (inside `supervisor::run`, before the Node server spawn), the launcher:

1. Resolves `<install_root>/current/ws-scrcpy-web-tray.exe`. If missing, log and skip.
2. Reads `HKLM\Software\Microsoft\Windows\CurrentVersion\Run\WsScrcpyWebTray`.
3. If present AND points at the resolved tray exe → log "already migrated" and return (idempotent fast path; no log noise on every restart).
4. Else → write the value via `reg.exe add ... /f`. Log outcome.

This is the load-bearing fix. It runs on every service start, including the restart triggered by `on_updated` after a Velopack upgrade. After v0.1.25-beta.2 ships, the FIRST service restart on any v0.1.24-installed-as-service box completes the HKLM migration.

### Path B — Tray helper acquires per-session single-instance mutex (user context)

When a tray helper instance starts (spawned by either HKLM\Run or HKCU\Run at logon, or any other future cause), it first attempts to acquire a **per-session named mutex**:

`Local\WsScrcpyWebTray-SingleInstance`

The `Local\` namespace prefix is the key: Windows automatically scopes this name to the current logon session, so two users logged in concurrently each have their own mutex and don't fight each other. Two trays in the SAME session race for the mutex; the loser exits silently within milliseconds.

Implementation mirrors `launcher/src/single_instance.rs` — `CreateMutexW` + `GetLastError == ERROR_ALREADY_EXISTS` discrimination — but simpler than the launcher version since the tray has no "elevated tray" concept (no User/Admin suffix).

### Path C — Mutex winner cleans stale HKCU\Run (user context)

After acquiring the mutex (Path B), the winning tray instance does a best-effort delete of `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\WsScrcpyWebTray` from the current user's hive. Effects:

- For the original installing admin: removes the stale v0.1.24 value. Next admin logon → only HKLM\Run fires → one tray.
- For all other users: HKCU\Run was empty already → reg.exe returns exit code 1 (value not found) → treated as success per the locale-stable pattern from `classify_reg_delete_outcome` in `elevated_runner.rs`.

Idempotent: once HKCU\Run is gone, subsequent starts hit the same "value not found" exit code 1 and short-circuit.

## File-level changes

| File | Change |
|---|---|
| `tray/src/single_instance.rs` | **New module.** Per-session named mutex, mirroring `launcher/src/single_instance.rs` pattern but simpler (no elevation segregation). |
| `tray/src/main.rs` | Acquire mutex first thing in `main()`. On `Ok(None)`, exit silently. On `Ok(Some(guard))`, hold guard for tray's lifetime. After acquiring, best-effort `reg.exe delete HKCU\...\Run /v WsScrcpyWebTray /f`. |
| `launcher/src/elevated_runner.rs` | New `pub fn migrate_tray_run_key_for_service(install_root: &Path) -> Result<(), String>` that resolves tray path, reads HKLM, writes if missing/wrong. Uses existing `register_tray_run_key` (made `pub(crate)` if not already) for the actual write. |
| `launcher/src/supervisor.rs` | Call `migrate_tray_run_key_for_service(install_root)` early in `run()` when service mode detected. Best-effort: log on failure, don't block service start. |
| `tray/Cargo.toml` | No changes — `windows` crate already present. |

No changes to `tray/Cargo.toml` deps. No changes to `launcher/Cargo.toml` deps.

## Migration timing — what users experience

**Fresh install of v0.1.25-beta.2:** Service install → `install_service()` writes HKLM (existing v0.1.25-beta.1 logic). All users get tray at next logon. No drama.

**Upgrade v0.1.24 → v0.1.25-beta.2 (admin applies in-app update):**
1. Velopack swaps binaries, fires `on_updated`.
2. `on_updated` calls `servy-cli restart` → service restarts.
3. New launcher.exe (v0.1.25-beta.2) starts under LocalSystem. **Path A self-heals: writes HKLM\Run.**
4. Admin's currently-running tray (spawned from HKCU\Run at this admin's logon) is still v0.1.24's binary — it doesn't yet do Path B+C. So admin still has one tray (from HKCU) until next logon.
5. Other users log in → HKLM\Run fires → tray helper (now v0.1.25-beta.2 binary) starts → **Path B+C run: acquires mutex (only tray in their session), best-effort deletes HKCU\Run (no-op, they never had it), runs normally.**
6. Admin logs out and back in → HKCU\Run AND HKLM\Run both fire → two tray.exe instances race. **Path B winner survives, loser exits silently. Winner runs Path C: deletes admin's stale HKCU\Run.**
7. Subsequent admin logons → only HKLM\Run fires → one tray. Migration complete.

Worst-case admin UX: one transitional logon where two trays briefly exist before mutex resolves (within milliseconds; the loser exits before its icon paints). Acceptable.

**Upgrade v0.1.25-beta.1 → v0.1.25-beta.2 (admin applies in-app update):**
- Service restarts → Path A still runs (idempotent). HKLM\Run was already written if `install_service` was previously triggered, OR is now written if it wasn't. Either way ends correct.
- Admin's tray on next logon → Path B+C runs. HKCU\Run was either already gone (if the prior install_service ran) or removed now. Either way ends correct.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| `CreateMutexW` returns Err for a transient resource issue, blocking tray startup. | Current launcher pattern proceeds without the guard on Err. Tray follows suit: log + run anyway. Worst case is a transient duplicate, not a hard fail. |
| `Local\` namespace doesn't isolate across sessions on some Windows configurations. | Documented Windows behavior since Vista. Test on Win11 multi-user VM (existing test setup). |
| Path A runs on every service start → log spam. | Skip-and-log fast path when HKLM is already correct. Log line is one per service start when migration is needed; zero per service start when already migrated. |
| Path C deletes HKCU\Run before admin's tray (spawned from that HKCU\Run) had a chance to spawn at the SAME logon → admin sees no tray that logon. | Doesn't happen. The HKCU\Run line in registry triggers `tray.exe` to spawn FIRST at logon; the tray.exe then runs its startup including Path C. So the spawn happens BEFORE the cleanup; nothing gets pre-empted. |
| `reg.exe` exit code 1 ambiguity (already discussed in §1c.7) — could mask real access-denied errors during Path C. | Same caveat documented in `classify_reg_delete_outcome`. For best-effort cleanup with `let _ =` callers, acceptable. |

## Testing strategy

### Unit tests

- `tray/src/single_instance.rs`:
  - `acquire_grants_first_caller`
  - `acquire_denies_second_caller_while_first_is_held`
  - `acquire_succeeds_again_after_first_drops`
  (Mirror launcher tests; use unique mutex names per test to avoid CI cross-talk.)
- `launcher/src/elevated_runner.rs`:
  - Pure-helper tests for `is_hklm_already_migrated(current_value: Option<String>, expected: &str)` if extracted, similar shape to `classify_reg_delete_outcome`.

### Manual VM verification (required pre-merge)

1. **Upgrade v0.1.24 → v0.1.25-beta.2** on the multi-user Win11 VM that currently has v0.1.25-beta.1 installed:
   - Sideload v0.1.25-beta.2 installer (or in-app update).
   - As admin: confirm `HKLM\...\Run\WsScrcpyWebTray` now present in regedit.
   - As admin: confirm only one tray icon (after one logout/login cycle to let Path C run).
   - Switch to non-admin user: confirm tray icon appears at logon.
   - Click tray on non-admin user → confirm "Open" navigates to live `localhost:<port>`.

2. **Confirm idempotency:** restart the service (`sc.exe stop/start WsScrcpyWeb`) — Path A should log "already migrated" and not re-write HKLM. Spot-check launcher.log.

3. **Single-instance gating sanity:** as admin in a clean session, manually launch a second `ws-scrcpy-web-tray.exe` from Explorer/cmd. Confirm it exits silently without a tray icon appearing.

## Out of scope for this fix (deferred)

- Cross-session tray killing on uninstall (still tracked separately; Theory D-era limitation).
- Migrating other users' HKCU values via cross-hive enumeration. Their hives are already empty; nothing to migrate.
- Adding HKCU cleanup to `on_updated` in launcher/src/hooks.rs. Path B+C in the tray helper is sufficient and avoids the privilege-context uncertainty around Velopack hooks.
