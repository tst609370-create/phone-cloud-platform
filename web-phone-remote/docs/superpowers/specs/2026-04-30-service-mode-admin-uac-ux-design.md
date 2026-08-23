# Service-mode admin/UAC UX hardening — design

**Date:** 2026-04-30
**Project:** ws-scrcpy-web
**Status:** Spec — not yet implemented (targets v0.1.25-beta.3 or stable, TBD)
**Closes todo:** §1c.5 (silent-fail-as-regular-user) + §1c.6 (admin-confirmation modal)

## Problem

Two reported issues with the service install/uninstall UX, both surfaced during v0.1.25-beta.1 multi-user VM testing:

1. **Silent-fail when a non-admin user clicks "uninstall service".** Button text changes to "uninstalling…" then nothing observable happens — no UAC prompt, no error, no progress, no completion. Service stays installed.
2. **No "this requires admin" pre-flight UX.** Even on the happy path (admin clicks install/uninstall), the resulting UAC prompt arrives unannotated and surprising. Users have no opportunity to bail before triggering it.

## Investigation findings — current uninstall flow

`POST /api/service/uninstall` (handled by `src/server/api/ServiceApi.ts::handleUninstall`) routes one of three ways depending on caller context:

1. **Resume-token path:** if the request includes `X-Resume-Token`, validate it and proceed straight to direct uninstall.
2. **Service-context handoff path:** if the backend is running as LocalSystem (i.e., the request hit the service-mode Node server, regardless of which user fired the request), call `handoffUninstallToUserSession` which:
   - Resolves the active console session via `WTSGetActiveConsoleSessionId` (returns the physical-console session, NOT necessarily the requesting user's session).
   - Writes a control marker to `<dataRoot>/control/uninstall-handoff.json` with `targetSessionId` and `--local-takeover` arg.
   - Polls `discover()` for up to 30 seconds for a new local launcher to bind a port.
   - On success, returns `ok: true, redirectTo: localhost:<new-port>` so the frontend redirects.
   - On 30-second timeout, returns `false` (handoff failed) and the caller falls through to direct uninstall.
3. **Direct uninstall path:** calls `result.client.uninstall()` → `ServyClient.uninstall` → `runElevated('uninstall-service', ...)` which uses PowerShell `Start-Process -Verb RunAs` to fire the UAC prompt in the **current process's session**.

The silent-fail mechanism, traced exactly:

> When a non-admin user clicks uninstall and `WTSGetActiveConsoleSessionId` returns the admin's session (or no tray helper consumes the marker for the user's session in the v0.1.25-beta.1 era when non-admins had no tray at all), `discover()` polls for 30s and times out. Backend then falls through to direct uninstall — but `runElevated` is called from a LocalSystem process which has no interactive desktop to display the UAC prompt on (this is documented in `elevatedRunner.ts:154` for the `spawn-user-launcher` command's `useDirect` path; the same constraint applies to ANY UAC attempt from LocalSystem). PowerShell's `Start-Process -Verb RunAs` does not error in a clean way — it returns success but the elevation never actually happens. The result-file polling then hangs/times out invisibly. The button stays "uninstalling…" until the frontend's fetch eventually returns.

In v0.1.25-beta.2, regular users now have a tray helper (HKLM-Run migration). The handoff SHOULD reach the user's session, the handoff launcher SHOULD spawn in their session, and `runElevated` SHOULD fire UAC visibly to the user. **This needs VM verification before we conclude the silent-fail is fully resolved.** This spec assumes verification will surface lingering edge cases (UAC-cancelled, marker target session mismatch when admin and user are simultaneously logged in) that we want to address.

## Goals

1. **Silent-fail elimination.** Any non-success outcome of an install/uninstall click results in a clear, surfaced error to the user instead of an indefinitely-stuck "uninstalling…" button.
2. **No UAC attempts from contexts that can't show one.** When backend is LocalSystem and the handoff fails, do NOT fall through to direct `runElevated` — that's the silent-fail trap. Surface a clear error instead with actionable guidance ("could not reach a tray helper to relay the request to your user session; please try again or contact support").
3. **Admin-confirmation modal.** Before initiating any action that requires UAC (install service, uninstall service), show a small modal: "This action requires Administrative Privileges. Continue?" with continue/cancel buttons. Cancel → no action, no UAC. Continue → proceeds to existing flow.
4. **Progress affordance during the 30s discover wait.** Keep the existing 30s `discover()` timeout (it's correctly empirically tuned for cold-boot VMs / slow startup). Once Q1's fix removes the LocalSystem direct-uninstall fallback, a 30s wait that ends in failure produces a clear error rather than a silent hang — so the timeout itself isn't the UX problem. But 30s of "uninstalling…" with no feedback IS noisy. Frontend should swap the button label to a "still waiting for user session…" affordance after 5s so the user knows it hasn't frozen.

## Non-goals

- Resolving UAC-cancelled state (user clicks "No" on the UAC prompt). Existing 403 + `isUacDeclined` handling is sufficient — we just need the frontend to display the error clearly.
- Adding non-admin password prompts, custom credential UI, or any deviation from Windows's standard UAC dialog.
- Backporting these changes to local-mode install/uninstall flows that didn't have the problem (the bug is service-context-specific).
- Changing the underlying Theory D handoff mechanism. It works correctly when both sides are wired; the issues are at the edges (UAC-incapable fallback, slow timeout, missing pre-flight UX).

## Approach

Three contracts spanning two layers, building in parallel:

### Contract 1 (backend → frontend response shape)

The `ServiceActionFailure` response gains a discriminated `reason` enum so the frontend can render the right message + offer the right next-step:

```ts
export interface ServiceActionFailure {
    ok: false;
    error: string;
    /** Discriminator added in v0.1.25 to drive frontend error UX. */
    reason?:
        | 'unsupported'        // service mode not supported on this platform
        | 'uac-declined'       // user clicked No on the UAC prompt
        | 'handoff-timeout'    // service-context handoff couldn't reach a tray
        | 'handoff-no-target'  // no active session resolvable / no tray running
        | 'invalid-token'      // resume-token validation failed
        | 'servy-failure'      // servy-cli exited non-zero
        | 'unknown';           // fallback
}
```

`reason` is optional for backward compat; absence is treated as `'unknown'`.

### Contract 2 (backend behavior change)

`handleUninstall` (and `handleInstall`, by symmetry) MUST NOT fall through to direct `runElevated('uninstall-service', ...)` from a LocalSystem context after a handoff failure. Instead, return `ok: false` with `reason: 'handoff-timeout'` and an actionable error message. The current line `log.warn('uninstall handoff failed; attempting direct uninstall...')` is the offending fallback; it must be replaced with a clean error response.

### Contract 3 (admin-confirmation modal API)

A new module `src/app/client/AdminConfirmModal.ts` exporting:

```ts
export class AdminConfirmModal {
    /**
     * Show a modal asking the user to confirm an action that will trigger UAC.
     * Returns a promise that resolves to true if the user clicked continue,
     * false if they clicked cancel or dismissed via Esc / overlay click.
     */
    public static confirm(opts: {
        action: 'install service' | 'uninstall service';
    }): Promise<boolean>;
}
```

Call sites: `SettingsModal::onInstallService` and `SettingsModal::onUninstallService`. Both gate the existing fetch on `await AdminConfirmModal.confirm({action: 'install service'})` (or 'uninstall service'). If the user cancels, no fetch is made; button text reverts.

## File-level changes

### Layer 1 — Backend (Node TS)

| File | Change |
|---|---|
| `src/common/ServiceEvents.ts` | Add `reason?` field to `ServiceActionFailure` with the enum above. Export the enum type for both server and client. |
| `src/server/api/ServiceApi.ts` | Update `handleUninstall` to NOT fall through to direct uninstall on handoff failure when `isLikelyLocalSystem()`. Return `ok: false, reason: 'handoff-timeout'` instead. Also tag every other `ServiceActionFailure` return with the appropriate `reason`. Discover timeout stays at 30_000ms (Theory D's empirically-tuned value covers cold-boot VMs). The install path is NOT touched for this hardening — it doesn't have the LocalSystem-fallback trap, since installs originate from local mode. |

Test files added/modified:
- `src/server/api/__tests__/ServiceApi.test.ts` — test the new "handoff-timeout returns failure, NOT direct fall-through" branch + the `reason` field shape on each existing failure path. Existing tests should still pass.

### Layer 2 — Frontend (DOM TS)

| File | Change |
|---|---|
| `src/app/client/AdminConfirmModal.ts` | **NEW.** Small dialog mirroring the existing modal patterns (use the same modal infra as WelcomeModal — see `feedback_modal_scroll_lock.md`). Static `confirm()` returns `Promise<boolean>`. |
| `src/style/modal.css` (or wherever modal styles live) | Add styles for `.admin-confirm-modal` if needed — likely reuses existing `.modal-overlay` + `.modal-card` classes. |
| `src/app/client/SettingsModal.ts` | In `onInstallService` and `onUninstallService`: before the `fetch(...)` call, `if (!await AdminConfirmModal.confirm({action: ...})) return;`. After the fetch fires (uninstall path only — install doesn't go through the handoff), set a 5-second `setTimeout` that swaps the button label from "uninstalling…" to "still waiting for user session…"; clear the timeout on response. Improve the error display: read `data.reason` and map to a user-friendly message + actionable hint (e.g., 'handoff-timeout' → "Couldn't reach the user session. Make sure ws-scrcpy-web is running for the user, then try again."). Use `renderServiceError` with the new mapped messages. |

No new imports of server-only modules into the frontend (per the `ServiceEvents.ts` rule).

Test files added/modified:
- `src/app/client/__tests__/AdminConfirmModal.test.ts` — **NEW.** Vitest unit tests for the modal: confirm clicked → resolves true; cancel clicked → resolves false; Esc → resolves false; overlay click → resolves false; modal cleans up DOM on resolve.
- `src/app/client/__tests__/SettingsModal.test.ts` (if exists) — extend or create. Test that install/uninstall buttons trigger the confirm modal before fetch; cancellation suppresses the fetch.

### Layer 3 — Rust launcher

**No changes.** The launcher's elevate-and-run path is correct as-is. The bug was upstream of it.

## Migration / compatibility

- The `reason` field is OPTIONAL. Older clients (none in the wild for this app, but framework-level safety) ignore unknown JSON fields, so no breaking change.
- `AdminConfirmModal` is purely additive frontend; no migration concern.
- Discover timeout unchanged at 30s; UX during the wait improves via the 5s "still waiting…" affordance.

## Testing strategy

### Unit tests (gate before tag)

- `ServiceApi.test.ts` — new "handoff failure returns ok:false, reason:'handoff-timeout', does not call ServyClient.uninstall" test using a mocked client. Existing tests stay green.
- `AdminConfirmModal.test.ts` — DOM unit tests covering confirm/cancel/Esc/overlay-click paths.
- Workspace `cargo test --workspace` and `npm test` both green.

### Manual VM verification (gates the tag)

1. **Admin clicks "uninstall service"**:
   - Confirm modal appears with "This action requires Administrative Privileges. Continue?".
   - Click cancel → no UAC, button reverts to "uninstall service?".
   - Click continue → existing flow proceeds (UAC fires, etc).
2. **Non-admin clicks "uninstall service"** (with v0.1.25-beta.2 tray fix in place):
   - Confirm modal appears.
   - Click continue → handoff fires → tray spawns user-session launcher → UAC password prompt fires for that user → user enters admin creds → uninstall completes.
3. **Non-admin clicks, then cancels UAC password prompt**:
   - Backend returns 403 ServiceActionFailure with `reason: 'uac-declined'`.
   - Frontend displays a clear "UAC declined" error with retry option.
4. **Force handoff failure** (kill all tray helpers in all sessions, then click uninstall as non-admin):
   - Backend's `discover()` times out after 30s.
   - During the wait, frontend swaps button label from "uninstalling…" to "still waiting for user session…" at the 5-second mark.
   - Backend returns `ok:false, reason:'handoff-timeout'` (NOT a hung "uninstalling…" state, NOT a silent fall-through to direct uninstall).
   - Frontend shows "Couldn't reach the user session…" error with retry.

### Pre-merge verification

- TypeScript compile clean (`npx tsc --noEmit`).
- Vitest suite passes (`npm test`).
- Cargo workspace tests pass (`cargo test --workspace`).
- Clippy clean (`cargo clippy --workspace --all-targets -- -D warnings`).

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| 30s timeout still too short for an unusually slow VM. | If VM testing surfaces a real failure mode where the launcher reliably needs >30s to bind, bump higher (45-60s) and revisit the user-facing affordance — the user's primary signal is the "still waiting…" label, not the absolute timeout. |
| `reason` field discriminator added without exhaustive switch enforcement could miss new cases. | TypeScript discriminated unions naturally enforce exhaustiveness in `switch` statements. Frontend's mapping function uses `never`-fallthrough to catch unhandled cases at build time. |
| AdminConfirmModal adds friction on the happy path (extra click before each install/uninstall). | Acceptable — these are infrequent operations (install/uninstall service, not regular use). Pre-flight confirmation matches platform conventions for admin-elevation UX. |
| Tests modeling the LocalSystem context are brittle. | Mock `os.userInfo()` directly in tests — this is how `isLikelyLocalSystem` resolves. Existing test patterns in ServyClient.test.ts already do this. |

## Out of scope (deferred)

- Symmetric handling for `install-service` direct-call from LocalSystem. The install path currently doesn't have the same trap because installs originate from local mode (no service running yet to be LocalSystem). Verify, but no fix needed.
- "I'm an admin, skip the confirm modal" preference. Could add a "don't ask again" checkbox later; not in this iteration.
- `linuxClient.uninstall` symmetric improvements. Linux uses systemd which doesn't have the same UAC-from-LocalSystem trap.
