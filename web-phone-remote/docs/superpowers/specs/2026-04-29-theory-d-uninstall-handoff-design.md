# Theory D — File-marker IPC for service-uninstall handoff

**Status:** Design approved 2026-04-29.
**Targets:** v0.1.24 (likely beta.8+).
**Scope:** Replaces the WTS cross-session spawn used in `ServiceApi.handoffUninstallToUserSession`. Closes §1c bug 1 (service-uninstall regression). Does NOT address §1c bug 2 (multi-user port drift) or §1c bug B (Path B fallback doesn't restore local tray) — those remain separate todo items.

---

## Background

When a user clicks **Uninstall** on a service-mode install, the service-Node (running as LocalSystem, session 0) needs to hand off the actual uninstall to a launcher running in the user's own logon session. The user-session launcher then:
1. Provides the post-uninstall UI (browser redirect + resume token).
2. Performs the `servy stop` + `servy uninstall` calls.
3. Spawns the local-mode tray icon for ongoing user-mode operation.

The original implementation used a Win32 cross-session pattern: `WTSGetActiveConsoleSessionId` → `WTSQueryUserToken` → `CreateProcessAsUserW`. Three v0.1.24 betas tried to make this work (privilege flips, session enumeration, primary-token forcing) and all failed. Beta.3 ended with `CreateProcessAsUserW → ERROR_ACCESS_DENIED` despite all three required privileges enabled and `lpDesktop = "winsta0\\default"` set.

User decision (2026-04-30): pivot to an architectural fix that eliminates the cross-session spawn entirely.

## Design

The service-Node writes a small JSON marker file to a known path under `<dataRoot>`. A polling thread inside the user-session tray helper detects the marker and natively spawns the user-session launcher. No cross-session token APIs are involved.

### Flow

```
[Service-Node, session 0]                    [Tray helper, session N]
─────────────────────────                    ─────────────────────────
1. user clicks Uninstall in Settings UI
2. ServiceApi writes
   <dataRoot>/control/uninstall-handoff.json   (atomic: temp + rename)
3. ServiceApi polls discover() for new
   launcher port (existing 30s loop)         4. poller thread (750ms cadence)
                                                detects marker
                                             5. validates targetSessionId == own
                                                session
                                             6. spawns <launcherPath>
                                                <launcherArgs...>
                                             7. deletes marker
                                             8. (poller continues idle, ready
                                                for re-uninstall)
9. user-session launcher comes up,
   binds free port
10. ServiceApi.discover() finds the new
    port, issues resume token, returns
    redirectTo body to the browser
11. browser navigates to new launcher,
    resume flow runs the actual uninstall
```

### Marker file

- **Path**: `<dataRoot>/control/uninstall-handoff.json`. The new `control/` subdirectory is reserved for marker files. Future verbs (other handoffs) reuse the same directory.
- **Schema**:
  ```json
  {
    "verb": "uninstall-service",
    "targetSessionId": 1,
    "launcherPath": "C:\\Program Files\\WsScrcpyWeb\\current\\ws-scrcpy-web-launcher.exe",
    "launcherArgs": ["--local-takeover"],
    "writtenAt": "2026-04-29T23:30:00Z"
  }
  ```
  - `verb`: identifies the marker type. Currently always `"uninstall-service"`.
  - `targetSessionId`: the active console session ID at the time the service was triggered. Tray helper checks this against its own session.
  - `launcherPath`: absolute path to the launcher exe to spawn.
  - `launcherArgs`: argv to pass to the launcher.
  - `writtenAt`: ISO-8601 UTC timestamp; used for stale-marker detection on tray helper startup.

- **Atomic write**: write `uninstall-handoff.json.tmp`, then rename to `uninstall-handoff.json`. Windows rename of an existing target requires `MOVEFILE_REPLACE_EXISTING` (Node's `fs.rename` does this). A partial JSON file never appears under the real filename.

- **Cleanup**:
  - Tray helper deletes the marker after a successful spawn.
  - On tray helper startup, any marker with `writtenAt` older than 60 seconds is deleted (stale, from a service crash or missed pickup window).

### Service-side change (`src/server/api/ServiceApi.ts`)

In `handoffUninstallToUserSession` (~line 480), replace the existing `runElevated('spawn-user-launcher', ...)` block:

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

with a marker write:

```ts
const writeResult = await writeControlMarker({
    verb: 'uninstall-service',
    targetSessionId: getActiveConsoleSessionId(),
    launcherPath,
    launcherArgs: ['--local-takeover'],
});
if (!writeResult.ok) {
    log.warn(`uninstall handoff: marker write failed: ${writeResult.errorMessage}`);
    return false;
}
```

The rest of the method (port discovery via `this.discover(...)`, token issuance, redirect response) is unchanged.

### Tray helper-side addition (`tray/src/main.rs`)

Before calling `common::tray::run(...)`, spawn a background poller thread:

```rust
let own_session = unsafe { WTSGetActiveConsoleSessionId() };
let marker_path = config_dir.join("control").join("uninstall-handoff.json");
let _poller = std::thread::spawn(move || {
    common::control_marker::poll_for_handoff(&marker_path, own_session);
});
let action = common::tray::run(...)?;
```

The poller (in `common::control_marker`):
1. On startup, delete any existing marker file with `writtenAt` older than 60 seconds.
2. Loop: sleep 750ms.
3. Read marker file. If absent or unparseable → continue loop.
4. If `targetSessionId != own_session` → continue loop (do NOT delete; another user's tray helper will handle it).
5. Spawn `launcherPath` with `launcherArgs` via `std::process::Command::new(...).args(...).spawn()`. Detached (no parent-child link beyond initial fd inheritance).
6. Delete marker file.
7. Continue loop (don't exit — supports re-uninstall within the same tray-helper lifetime).

The thread runs for the lifetime of the tray helper. When the tray helper exits, the thread is killed by process termination (acceptable; nothing is mid-write).

### Multi-user safety

- `targetSessionId` in the marker is the only mechanism preventing User B's tray helper from acting on User A's marker.
- Active console session is computed by the service-Node via `WTSGetActiveConsoleSessionId()` (a Win32 read-only call; no privileges required, returns the session at the physical console).
- Tray helpers compute their own session via the same call.
- In Hyper-V Enhanced Session and other RDP-like scenarios, "active console" can be ambiguous. The fallback if mismatch occurs: tray helper ignores the marker, service times out, fallback path runs. Same UX as today's broken state (degraded, not catastrophic).
- `<dataRoot>/control/` inherits the existing `Authenticated Users:Modify (OI)(CI)` ACL on `<dataRoot>`. No new attack surface beyond the rest of the data root.

### Failure modes

| Scenario | Behavior |
|---|---|
| No tray helper running for active session (user killed it) | Service `discover()` times out at 30s → falls through to direct uninstall. Browser sees "couldn't reach server" — same as today. |
| Tray helper crashes mid-spawn | Marker stays on disk. If launcher started successfully before the crash, `discover()` succeeds normally. If not, fallback. Stale marker is cleaned on next tray helper startup. |
| Service crashes mid-marker-write | Atomic rename means partial file never visible under real filename. Worst case: orphaned `.tmp` file (cleaned up on next service-side write that overwrites it). |
| User clicks Uninstall twice rapidly | Second write overwrites the first. Tray helper sees one current marker, spawns once, deletes. Idempotent. |
| Marker present at tray-helper startup with `targetSessionId` != own session | Tray helper does NOT delete (could be a fresh marker for a different active session). Standard polling rules apply. Stale-age cleanup still fires (60s), so abandoned markers don't accumulate. |

### Polling cadence

**750 ms** — chosen because:
- A 750ms loop is ~1.3 polls/sec, dominated by a single `stat` syscall when the file is absent. Negligible CPU.
- User-perceived handoff latency is dominated by launcher startup (~3s) and `discover()`'s port-probing loop, not poll cadence.
- Faster (250ms) provides no perceptible benefit. Slower (2s+) starts to feel laggy on the redirect.

### Open decisions (recorded for future revision after market test)

1. **Marker subdirectory** (`control/`) vs. dropping the file directly under `<dataRoot>`. Subdirectory chosen for cleanliness and future extensibility.
2. **JSON schema** vs. plain-text or fixed-format binary. JSON chosen for debuggability and easy schema evolution.
3. **Tray helper polls always** (even in pure user mode where the service can't write markers). Conditional polling adds branching for ~zero CPU savings.
4. **Stale-marker age**: 60 seconds. Long enough that no legitimate handoff would still be in flight; short enough that abandoned markers don't linger past a single user session.
5. **Polling continues after first hit** (don't exit poller thread). Supports re-uninstall within same tray-helper lifetime.
6. **`launcher/src/user_session_spawn.rs` and `elevated_runner.rs` `spawn-user-launcher` dispatch**: keep source for now, just unhook from call paths. Delete in a later cleanup pass once Theory D has stabilized in production.

These can be revised after VM testing reveals real-world behavior. None of them are load-bearing for correctness.

## Files touched

| File | Change |
|---|---|
| `common/src/control_marker.rs` (new) | Marker schema + write/read/delete + poller helpers (Rust). Exposed via `common::control_marker::{Marker, write, poll_for_handoff, ...}`. |
| `common/src/lib.rs` (edit) | `pub mod control_marker;` |
| `tray/src/main.rs` (edit) | Spawn poller thread before `tray::run`. |
| `tray/Cargo.toml` (edit) | (none expected — `common` already listed) |
| `src/server/util/control-marker.ts` (new) | TypeScript helper to write the marker. Mirrors the Rust schema. |
| `src/server/util/active-session.ts` (new) | TypeScript helper that calls `WTSGetActiveConsoleSessionId`. Implementation: shell out to a tiny Rust helper exe OR use `node-ffi-napi` / Node's `child_process` with PowerShell. Decided in writing-plans. |
| `src/server/api/ServiceApi.ts` (edit) | Replace `runElevated('spawn-user-launcher', ...)` call with marker write (~10 lines net). |
| `launcher/src/user_session_spawn.rs` (no change in this design; cleanup deferred) | (kept; not invoked by ServiceApi anymore) |
| `launcher/src/elevated_runner.rs` (no change in this design; cleanup deferred) | (`spawn-user-launcher` dispatch becomes dead code) |

## Test plan

- **Unit (Rust)**: `control_marker` write/read/delete round-trip; stale-detection threshold; session-mismatch ignore behavior.
- **Unit (TS)**: `writeControlMarker` produces valid JSON; failure mode when `<dataRoot>/control/` is unwritable.
- **Integration (Rust, mocked launcher)**: poll thread detects a freshly-written marker, spawns the configured exe (a stub that exits 0), deletes the marker.
- **End-to-end (VM, manual)**: fresh-install MSI → service-mode install → click Uninstall in Settings → expect smooth redirect to user-session launcher, uninstall completes, local tray appears.
- **Multi-user (deferred to bug-2 session)**: out of scope here.

## Out of scope

- §1c bug 2 (multi-user port drift in service mode).
- §1c bug B (Path B local-mode uninstall doesn't restore tray). With Theory D fixing the primary path, B's trigger goes away in the success case. The fallback case (no tray helper) still hits B; that's tracked separately.
- Cleanup of `user_session_spawn.rs` and the `spawn-user-launcher` dispatch case in `elevated_runner.rs`. Deferred to a post-stabilization sweep.

## Acceptance

- VM test: service-mode install + click Uninstall in Settings completes the full flow with a single redirect (no manual launcher relaunch needed).
- `launcher.log` shows the user-session launcher booting via `--local-takeover` after the marker is written, NOT via WTS handoff.
- No `WTSQueryUserToken`, `CreateProcessAsUserW`, or related cross-session API is invoked during uninstall.
