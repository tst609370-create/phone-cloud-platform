# Service-Mode Admin/UAC UX Implementation Plan

> **For agentic workers:** This plan is structured for `/build-with-agent-team` parallel execution. After Phase 0 (the contract foundation) lands, Phase 1A (backend) and Phase 1B (frontend) can build in parallel. Phase 2 is the integration check. Sub-skill alternative: `superpowers:subagent-driven-development` with sequential per-task dispatch.

**Goal:** Eliminate the silent-fail trap when non-admin users click uninstall service, and add a pre-flight admin-confirmation modal to install/uninstall buttons. Closes todo §1c.5 + §1c.6.

**Architecture:** Three contracts spanning two layers. (1) Backend response shape gains a `reason` discriminator on `ServiceActionFailure`. (2) Backend stops falling through to direct uninstall after handoff failure from LocalSystem context. (3) Frontend gates install/uninstall on a new `AdminConfirmModal.confirm()` and surfaces backend failure reasons with actionable messages.

**Tech Stack:** TypeScript (Node backend + DOM frontend), vitest, existing `Modal` base class at `src/app/ui/Modal.ts`.

**Spec:** `docs/superpowers/specs/2026-04-30-service-mode-admin-uac-ux-design.md`

---

## File Structure

**Files modified:**
- `src/common/ServiceEvents.ts` — extend `ServiceActionFailure` with `reason?` field + new `ServiceFailureReason` type alias.
- `src/server/api/ServiceApi.ts` — tag every `ServiceActionFailure` return with a `reason`; change handoff-failure path to return `ok:false` instead of falling through to direct uninstall.
- `src/server/__tests__/ServiceApi.test.ts` — extend with reason-coverage tests + new "handoff failure does not direct-uninstall" test.
- `src/app/client/SettingsModal.ts` — gate install/uninstall on `AdminConfirmModal.confirm()`; add 5s "still waiting…" label swap on uninstall; map `data.reason` to user-friendly messages.

**Files created:**
- `src/app/client/AdminConfirmModal.ts` — new modal extending the existing `Modal` base class; static `confirm({action})` returns `Promise<boolean>`.
- `src/app/client/__tests__/AdminConfirmModal.test.ts` — new vitest suite covering confirm/cancel/Esc/backdrop paths.

**No new CSS files.** AdminConfirmModal reuses the existing modal infra styles (`.modal`, `.modal-frame`, `.modal-body`, `.modal-footer` per `src/app/ui/Modal.ts`).

**No Rust changes.** The launcher's elevate-and-run path is correct as-is.

---

## Integration Contracts (Phase 0 — must land before parallel work)

### Contract 1 — `ServiceFailureReason` enum

The single source of truth lives in `src/common/ServiceEvents.ts`:

```ts
/**
 * Discriminator added in v0.1.25 to drive frontend error UX. Optional for
 * backward compatibility — older callers ignore unknown fields, and frontend
 * treats absence as 'unknown'. Add new variants here AND extend the
 * frontend mapping in `SettingsModal.ts::reasonToUserMessage` in the same
 * change to keep the discriminated union exhaustive.
 */
export type ServiceFailureReason =
    | 'unsupported'
    | 'uac-declined'
    | 'handoff-timeout'
    | 'handoff-no-target'
    | 'invalid-token'
    | 'servy-failure'
    | 'unknown';

export interface ServiceActionFailure {
    ok: false;
    error: string;
    reason?: ServiceFailureReason;
}
```

**Variant semantics (load-bearing for both layers):**

| Variant | When backend returns it | Frontend message |
|---|---|---|
| `unsupported` | Service mode not supported on this platform (Linux pre-systemd path, etc.) | "Service mode is not supported on this platform." |
| `uac-declined` | User clicked No on the UAC prompt; PowerShell `Start-Process -Verb RunAs` exited with ERROR_CANCELLED 1223. | "Administrative privileges were declined. Try again and approve the prompt." |
| `handoff-timeout` | `discover()` polled for 30s and never found a new local launcher to redirect to. | "Couldn't reach the user session. Make sure ws-scrcpy-web is running for your user, then try again." |
| `handoff-no-target` | Active session resolution failed AND no fallback path (reserved for future granularity; not emitted today but reserved in the type). | "Couldn't identify a user session to relay the action to." |
| `invalid-token` | Resume token validation failed. | "Resume token is invalid or expired. Refresh the page and try again." |
| `servy-failure` | servy-cli exited non-zero on actual install/uninstall. | "Service install/uninstall failed: \<details\>." |
| `unknown` | Catch-all when a failure path predates this work or wasn't categorized. | "An unexpected error occurred: \<details\>." |

### Contract 2 — `AdminConfirmModal.confirm()` API

The single source of truth lives in `src/app/client/AdminConfirmModal.ts`:

```ts
export interface AdminConfirmOptions {
    action: 'install service' | 'uninstall service';
}

export class AdminConfirmModal extends Modal {
    /**
     * Show a modal asking the user to confirm an action that will trigger UAC.
     * Returns a promise that resolves to true if the user clicked continue,
     * false if they clicked cancel, dismissed via Esc, or clicked the backdrop.
     */
    public static confirm(opts: AdminConfirmOptions): Promise<boolean>;
}
```

**Resolution semantics:**
- "Continue" button click → `resolve(true)`, modal closes.
- "Cancel" button click → `resolve(false)`, modal closes.
- Esc key → `resolve(false)`, modal closes.
- Backdrop click → `resolve(false)`, modal closes.
- The promise resolves exactly once. Subsequent close events are ignored.

### Contract 3 — Backend behavior

`handleUninstall` MUST NOT fall through to direct `runElevated('uninstall-service', ...)` when `isLikelyLocalSystem()` returns true AND `handoffUninstallToUserSession` returned false. The current line `log.warn('uninstall handoff failed; attempting direct uninstall...')` followed by the try/catch around `result.client.uninstall()` is the offending fallback. It must be replaced with a `ServiceActionFailure` response with `reason: 'handoff-timeout'`.

This change applies ONLY to the LocalSystem context path (line 393-397 of ServiceApi.ts). The local-mode `handleUninstall` (no LocalSystem, direct UAC works) continues to call `result.client.uninstall()` as before.

---

## Phase 0: Foundation — Contract Type (sequential, blocks Phase 1)

### Task 0: Add `ServiceFailureReason` to common types

**Owner:** lead agent (single change, blocks both phase-1 layers)

**Files:**
- Modify: `src/common/ServiceEvents.ts`

- [ ] **Step 1: Edit `src/common/ServiceEvents.ts`**

Find the `ServiceActionFailure` interface (around line 60). Replace with the contract code from the Phase 0 Contract 1 section above (the full `ServiceFailureReason` type + extended `ServiceActionFailure`). Keep `ServiceInstallResponse` and `ServiceUninstallResponse` as they are — `ServiceActionFailure` is referenced by both.

- [ ] **Step 2: Type-check the workspace**

```bash
cd C:/Users/jscha/source/repos/ws-scrcpy-web && npx tsc --noEmit
```

Expected: PASS. The new field is optional, so no existing callers break.

- [ ] **Step 3: Commit**

```bash
cd C:/Users/jscha/source/repos/ws-scrcpy-web && git add src/common/ServiceEvents.ts && git commit -m "feat(common): add ServiceFailureReason discriminator to action failure response

New optional 'reason' field on ServiceActionFailure carries a closed-set
enum so the frontend can render specific user-facing messages and pick
actionable follow-up offers. Variants documented inline. Backward-compat
because the field is optional — older callers ignore unknown fields and
treat absence as 'unknown'.

Foundation for §1c.5 silent-fail-elimination + §1c.6 admin-confirm modal.
Per spec docs/superpowers/specs/2026-04-30-service-mode-admin-uac-ux-design.md."
```

---

## Phase 1A: Backend — Tag failures + cut LocalSystem fallback (parallel with 1B)

### Task 1A.1: Tag every existing `ServiceActionFailure` return with a `reason`

**Owner:** backend agent

**Files:**
- Modify: `src/server/api/ServiceApi.ts`

- [ ] **Step 1: Tag the `unsupported` failures**

There are several spots where `result.supported === false` produces a failure response. Find each and add `reason: 'unsupported' as const` to the body literal. Example call site (around line 349-352):

```ts
const body: ServiceActionFailure = {
    ok: false,
    error: result.unsupportedReason ?? 'Service mode unsupported on this platform',
};
```

becomes:

```ts
const body: ServiceActionFailure = {
    ok: false,
    error: result.unsupportedReason ?? 'Service mode unsupported on this platform',
    reason: 'unsupported',
};
```

Apply this to ALL `unsupported` failure returns in the file. Use grep to find them: `grep -n "Service mode unsupported\|result.supported" src/server/api/ServiceApi.ts`.

- [ ] **Step 2: Tag the `invalid-token` failure**

Around line 373:

```ts
const body: ServiceActionFailure = {
    ok: false,
    error: 'invalid or expired resume token',
};
```

becomes:

```ts
const body: ServiceActionFailure = {
    ok: false,
    error: 'invalid or expired resume token',
    reason: 'invalid-token',
};
```

- [ ] **Step 3: Tag the `uac-declined` failure**

Around line 403-407 (inside the `catch (err)` block of `handleUninstall`'s direct-uninstall path):

```ts
if (err instanceof ServiceInstallError && err.isUacDeclined()) {
    const body: ServiceActionFailure = { ok: false, error: err.message };
    res.writeHead(403);
    res.end(JSON.stringify(body));
    return true;
}
```

becomes:

```ts
if (err instanceof ServiceInstallError && err.isUacDeclined()) {
    const body: ServiceActionFailure = { ok: false, error: err.message, reason: 'uac-declined' };
    res.writeHead(403);
    res.end(JSON.stringify(body));
    return true;
}
```

Also do this in `handleInstall` for symmetry — search for other `isUacDeclined()` checks in the file and tag them the same way.

- [ ] **Step 4: Tag the catch-all `servy-failure`**

Each `handleUninstall`/`handleInstall` `catch` block has a final `const body: ServiceActionFailure = { ok: false, error: (err as Error).message };` for unrecognized errors. Tag those with `reason: 'servy-failure' as const`. Example around line 409-411:

```ts
const body: ServiceActionFailure = { ok: false, error: (err as Error).message };
```

becomes:

```ts
const body: ServiceActionFailure = { ok: false, error: (err as Error).message, reason: 'servy-failure' };
```

- [ ] **Step 5: Tag any remaining failure paths**

Run `grep -n "ServiceActionFailure" src/server/api/ServiceApi.ts` and visit each site. Any return without `reason` should be tagged with whichever variant fits best, or `'unknown'` if it's a genuinely uncategorized error path.

- [ ] **Step 6: Type-check**

```bash
cd C:/Users/jscha/source/repos/ws-scrcpy-web && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd C:/Users/jscha/source/repos/ws-scrcpy-web && git add src/server/api/ServiceApi.ts && git commit -m "feat(server): tag service-mode failure responses with reason discriminator

Every ServiceActionFailure return in ServiceApi now carries a 'reason'
field per the v0.1.25 contract. Frontend will use this to map failure
modes to specific user-facing messages and actionable follow-up offers.

No behavior change beyond the response shape — all current code paths
land in the same place; they just announce themselves more precisely
on the way out."
```

### Task 1A.2: Cut the LocalSystem direct-uninstall fallback

**Owner:** backend agent

**Files:**
- Modify: `src/server/api/ServiceApi.ts` — `handleUninstall` LocalSystem path.

- [ ] **Step 1: Find the offending fallback block**

Around lines 393-397 of `handleUninstall`:

```ts
if (isWindows && runningAsService && this.isLikelyLocalSystem()) {
    const handoff = await this.handoffUninstallToUserSession(cfg.dependenciesPath, res);
    if (handoff) return true;
    log.warn('uninstall handoff failed; attempting direct uninstall (browser tab will likely disconnect)');
}
```

The `if (handoff) return true;` means a successful handoff returns immediately. The `log.warn` is the start of the fallthrough — execution continues to the `try { await result.client.uninstall(...) }` block below.

- [ ] **Step 2: Replace fallthrough with explicit failure response**

Replace the block above with:

```ts
if (isWindows && runningAsService && this.isLikelyLocalSystem()) {
    const handoff = await this.handoffUninstallToUserSession(cfg.dependenciesPath, res);
    if (handoff) return true;
    // Handoff failed AND we're running as LocalSystem. We CANNOT fall
    // through to direct runElevated() here — PowerShell Start-Process
    // -Verb RunAs from LocalSystem has no interactive desktop to show
    // the UAC prompt on, so it silently fails. Return a clear error
    // and let the user retry (per spec
    // docs/superpowers/specs/2026-04-30-service-mode-admin-uac-ux-design.md).
    const body: ServiceActionFailure = {
        ok: false,
        error: "Couldn't reach the user session to relay the uninstall request. Make sure ws-scrcpy-web is running for your user, then try again.",
        reason: 'handoff-timeout',
    };
    res.writeHead(503);
    res.end(JSON.stringify(body));
    return true;
}
```

The `503 Service Unavailable` HTTP status reflects "we can't service this right now, retry later" semantically — appropriate for the handoff-timeout case.

- [ ] **Step 3: Type-check**

```bash
cd C:/Users/jscha/source/repos/ws-scrcpy-web && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd C:/Users/jscha/source/repos/ws-scrcpy-web && git add src/server/api/ServiceApi.ts && git commit -m "fix(server): don't fall through to direct uninstall after LocalSystem handoff failure

PowerShell Start-Process -Verb RunAs has no interactive desktop to show
the UAC prompt on when called from a LocalSystem process, so the
post-handoff-failure direct uninstall was silently failing. Replaces
the fallthrough with an explicit 503 ServiceActionFailure response
tagged reason='handoff-timeout'. The user gets a clear error and can
retry instead of staring at a hung 'uninstalling…' button.

Closes the silent-fail trap (todo §1c.5) for non-admin users (and admin
users in the rare case the handoff couldn't find a tray helper)."
```

### Task 1A.3: Tests for the new backend behavior

**Owner:** backend agent

**Files:**
- Modify: `src/server/__tests__/ServiceApi.test.ts`

- [ ] **Step 1: Add a failing test for the no-fallback behavior**

Find the existing `describe('handleUninstall', ...)` block (or similar) in `src/server/__tests__/ServiceApi.test.ts`. Add a new `it` block AFTER the existing tests:

```ts
it('returns 503 with reason=handoff-timeout when LocalSystem handoff fails (does NOT direct-uninstall)', async () => {
    const uninstallSpy = vi.fn();
    const factory = () => ({
        supported: true,
        platform: 'win32' as const,
        client: {
            install: vi.fn(),
            uninstall: uninstallSpy,
            status: vi.fn().mockResolvedValue('running'),
        },
    });

    const api = new ServiceApi(factory);
    // Force isLikelyLocalSystem() to return true.
    vi.spyOn(api as unknown as { isLikelyLocalSystem: () => boolean }, 'isLikelyLocalSystem').mockReturnValue(true);
    // Force the handoff to fail.
    vi.spyOn(api as unknown as { handoffUninstallToUserSession: (...args: unknown[]) => Promise<boolean> }, 'handoffUninstallToUserSession').mockResolvedValue(false);
    // Set installMode to 'system-service' so the running-as-service branch fires.
    Config.getInstance().updateAppConfig({ installMode: 'system-service' });

    const req = mockReq({ method: 'POST', url: '/api/service/uninstall' });
    const res = mockRes();

    await api.handle(req, res);

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('handoff-timeout');
    expect(uninstallSpy).not.toHaveBeenCalled();
});
```

The exact mock helpers `mockReq`/`mockRes` and `Config.getInstance` access patterns should mirror the existing tests in this file — read them first and match the style. If the existing tests use a different mocking pattern (e.g., `vi.fn()` for a single client instance), adapt the test above to that pattern.

- [ ] **Step 2: Run the new test, verify it FAILS against current main**

```bash
cd C:/Users/jscha/source/repos/ws-scrcpy-web && npx vitest run src/server/__tests__/ServiceApi.test.ts -t "returns 503 with reason=handoff-timeout"
```

Expected: FAIL — current code falls through to direct uninstall, which would call `uninstallSpy` and return 200 or some other status, not 503.

- [ ] **Step 3: Run the test against the Task 1A.2 fix (already committed)**

The fix is already on the branch from Task 1A.2. The test should now PASS.

```bash
cd C:/Users/jscha/source/repos/ws-scrcpy-web && npx vitest run src/server/__tests__/ServiceApi.test.ts -t "returns 503 with reason=handoff-timeout"
```

Expected: PASS.

- [ ] **Step 4: Add reason-coverage tests for other failure paths**

Add tests asserting `body.reason` matches the expected variant for:
- `unsupported`: factory returns `{ supported: false, ... }`.
- `uac-declined`: client.uninstall throws `ServiceInstallError` with `isUacDeclined() === true`.
- `invalid-token`: request includes `X-Resume-Token: bad-token`.
- `servy-failure`: client.uninstall throws a generic Error.

Each test mirrors the existing pattern. Confirm `reason` is set correctly. Example for `unsupported`:

```ts
it('returns reason=unsupported when service mode is unsupported', async () => {
    const factory = () => ({
        supported: false,
        platform: 'linux' as const,
        unsupportedReason: 'systemd not found',
    });
    const api = new ServiceApi(factory);
    const req = mockReq({ method: 'POST', url: '/api/service/uninstall' });
    const res = mockRes();
    await api.handle(req, res);
    expect(res.statusCode).toBe(501);
    const body = JSON.parse(res.body);
    expect(body.reason).toBe('unsupported');
});
```

- [ ] **Step 5: Run the full ServiceApi test suite**

```bash
cd C:/Users/jscha/source/repos/ws-scrcpy-web && npx vitest run src/server/__tests__/ServiceApi.test.ts
```

Expected: all tests pass (existing + 5 new).

- [ ] **Step 6: Commit**

```bash
cd C:/Users/jscha/source/repos/ws-scrcpy-web && git add src/server/__tests__/ServiceApi.test.ts && git commit -m "test(server): cover ServiceActionFailure reason discriminator + no-direct-uninstall guard

Adds 5 tests:
- LocalSystem handoff failure returns 503 + reason='handoff-timeout' AND
  does NOT call client.uninstall() (the silent-fail regression guard).
- unsupported, uac-declined, invalid-token, servy-failure paths each
  return their expected reason variant.

Anchors the contract from src/common/ServiceEvents.ts on the backend
side and prevents accidental regressions to the LocalSystem-fallthrough
silent-fail behavior."
```

---

## Phase 1B: Frontend — AdminConfirmModal + reason mapping (parallel with 1A)

### Task 1B.1: Create `AdminConfirmModal`

**Owner:** frontend agent

**Files:**
- Create: `src/app/client/AdminConfirmModal.ts`

- [ ] **Step 1: Create the modal class**

Write `src/app/client/AdminConfirmModal.ts`:

```ts
import { Modal } from '../ui/Modal';

export interface AdminConfirmOptions {
    action: 'install service' | 'uninstall service';
}

/**
 * Pre-flight modal shown before any action that triggers Windows UAC,
 * so the user can bail out before the OS prompt fires. Resolves to
 * true if the user clicked Continue, false for any cancellation path
 * (Cancel button, Esc, backdrop click, X close button).
 *
 * Static `confirm()` is the only public API — callers don't construct
 * the class directly. The promise resolves exactly once; subsequent
 * close events are ignored.
 */
export class AdminConfirmModal extends Modal {
    private resolveFn: ((value: boolean) => void) | null = null;
    private resolved = false;
    private readonly action: 'install service' | 'uninstall service';

    public static confirm(opts: AdminConfirmOptions): Promise<boolean> {
        return new Promise((resolve) => {
            const modal = new AdminConfirmModal(opts, resolve);
            document.body.appendChild((modal as unknown as { dialog: HTMLDialogElement }).dialog);
            (modal as unknown as { dialog: HTMLDialogElement }).dialog.showModal();
        });
    }

    private constructor(opts: AdminConfirmOptions, resolve: (value: boolean) => void) {
        super({ title: 'Administrative Privileges Required' });
        this.resolveFn = resolve;
        this.action = opts.action;
        this.dialog.classList.add('admin-confirm-modal');
        // Defer body fill past class-field init phase (matches WelcomeModal pattern).
        queueMicrotask(() => this.fillBody(this.bodyEl));
    }

    protected buildBody(_container: HTMLElement): void {
        // Body content rendered by fillBody() from the constructor via queueMicrotask.
    }

    private fillBody(container: HTMLElement): void {
        const message = document.createElement('p');
        message.style.cssText = 'margin: 0 0 12px;';
        message.textContent = `${this.capitalizedAction()} requires administrative privileges. Windows will show a UAC prompt next.`;
        container.appendChild(message);

        const question = document.createElement('p');
        question.style.cssText = 'margin: 0 0 8px;';
        question.textContent = 'Continue?';
        container.appendChild(question);
    }

    protected buildFooter(): HTMLElement | null {
        const footer = document.createElement('div');
        footer.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'settings-btn';
        cancelBtn.textContent = 'cancel';
        cancelBtn.addEventListener('click', () => this.resolveAndClose(false));
        footer.appendChild(cancelBtn);

        const continueBtn = document.createElement('button');
        continueBtn.type = 'button';
        continueBtn.className = 'settings-btn settings-btn-primary';
        continueBtn.textContent = 'continue';
        continueBtn.addEventListener('click', () => this.resolveAndClose(true));
        footer.appendChild(continueBtn);

        return footer;
    }

    protected onEscapeKey(_event: Event): void {
        this.resolveAndClose(false);
    }

    protected onBackdropClick(_event: MouseEvent): void {
        this.resolveAndClose(false);
    }

    protected onCloseButtonClick(): void {
        this.resolveAndClose(false);
    }

    private resolveAndClose(value: boolean): void {
        if (this.resolved) return;
        this.resolved = true;
        this.resolveFn?.(value);
        this.resolveFn = null;
        this.close(value);
    }

    private capitalizedAction(): string {
        return this.action.charAt(0).toUpperCase() + this.action.slice(1);
    }
}
```

- [ ] **Step 2: Type-check**

```bash
cd C:/Users/jscha/source/repos/ws-scrcpy-web && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd C:/Users/jscha/source/repos/ws-scrcpy-web && git add src/app/client/AdminConfirmModal.ts && git commit -m "feat(app): AdminConfirmModal — pre-flight gate for UAC-triggering actions

New Modal subclass with a static confirm() method that returns
Promise<boolean>. Resolves true on Continue, false on any cancellation
path (Cancel button, Esc, backdrop, X close). Promise resolves exactly
once.

Will gate SettingsModal install/uninstall service buttons in the next
commit so users can bail before the Windows UAC prompt fires."
```

### Task 1B.2: Tests for `AdminConfirmModal`

**Owner:** frontend agent

**Files:**
- Create: `src/app/client/__tests__/AdminConfirmModal.test.ts`

- [ ] **Step 1: Write the test suite**

Write `src/app/client/__tests__/AdminConfirmModal.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AdminConfirmModal } from '../AdminConfirmModal';

// JSDOM doesn't implement HTMLDialogElement.showModal() by default; stub it.
beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute('open');
    });
});

afterEach(() => {
    // Clear any modal/dialog elements left over between tests. Use
    // replaceChildren() rather than innerHTML to satisfy the security-
    // reminder hook (innerHTML with strings is flagged even when empty).
    document.body.replaceChildren();
});

function getDialog(): HTMLDialogElement {
    const dialog = document.querySelector('dialog.admin-confirm-modal');
    expect(dialog, 'modal dialog should be in the DOM').toBeTruthy();
    return dialog as HTMLDialogElement;
}

function getButton(label: string): HTMLButtonElement {
    const btns = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
    const btn = btns.find((b) => b.textContent?.trim().toLowerCase() === label.toLowerCase());
    expect(btn, `button labeled "${label}" should be in the DOM`).toBeTruthy();
    return btn!;
}

describe('AdminConfirmModal.confirm', () => {
    it('resolves true when Continue is clicked', async () => {
        const promise = AdminConfirmModal.confirm({ action: 'install service' });
        // Wait one microtask so the queueMicrotask body-fill runs.
        await Promise.resolve();
        getButton('continue').click();
        await expect(promise).resolves.toBe(true);
    });

    it('resolves false when Cancel is clicked', async () => {
        const promise = AdminConfirmModal.confirm({ action: 'uninstall service' });
        await Promise.resolve();
        getButton('cancel').click();
        await expect(promise).resolves.toBe(false);
    });

    it('resolves false when Esc is pressed', async () => {
        const promise = AdminConfirmModal.confirm({ action: 'install service' });
        await Promise.resolve();
        const dialog = getDialog();
        const cancelEvent = new Event('cancel', { cancelable: true });
        dialog.dispatchEvent(cancelEvent);
        await expect(promise).resolves.toBe(false);
    });

    it('resolves false when backdrop is clicked', async () => {
        const promise = AdminConfirmModal.confirm({ action: 'install service' });
        await Promise.resolve();
        const dialog = getDialog();
        // Backdrop click = click event whose target is the dialog element itself
        // (not a child). The Modal base class checks e.target === this.dialog.
        const clickEvent = new MouseEvent('click', { bubbles: true });
        Object.defineProperty(clickEvent, 'target', { value: dialog });
        dialog.dispatchEvent(clickEvent);
        await expect(promise).resolves.toBe(false);
    });

    it('resolves only once even if multiple close paths fire', async () => {
        const promise = AdminConfirmModal.confirm({ action: 'install service' });
        await Promise.resolve();
        getButton('continue').click();
        // Subsequent close paths must not flip the resolution.
        getButton('cancel').click();
        await expect(promise).resolves.toBe(true);
    });

    it('renders action-specific copy in the body', async () => {
        const promise = AdminConfirmModal.confirm({ action: 'uninstall service' });
        await Promise.resolve();
        const body = document.querySelector('.modal-body');
        expect(body?.textContent?.toLowerCase()).toContain('uninstall service');
        // Resolve so the test cleans up.
        getButton('cancel').click();
        await promise;
    });
});
```

- [ ] **Step 2: Run the tests**

```bash
cd C:/Users/jscha/source/repos/ws-scrcpy-web && npx vitest run src/app/client/__tests__/AdminConfirmModal.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 3: Commit**

```bash
cd C:/Users/jscha/source/repos/ws-scrcpy-web && git add src/app/client/__tests__/AdminConfirmModal.test.ts && git commit -m "test(app): cover AdminConfirmModal resolution paths

6 tests covering: Continue resolves true, Cancel resolves false, Esc
resolves false, backdrop click resolves false, idempotent single
resolution, action-specific copy renders in the body. JSDOM-safe
(stubs HTMLDialogElement.showModal/close which JSDOM doesn't
implement)."
```

### Task 1B.3: Wire AdminConfirmModal into SettingsModal + reason mapping + 5s affordance

**Owner:** frontend agent

**Files:**
- Modify: `src/app/client/SettingsModal.ts`

- [ ] **Step 1: Add the import + reason→message helper**

At the top of `src/app/client/SettingsModal.ts`, add the import:

```ts
import { AdminConfirmModal } from './AdminConfirmModal';
```

(Add it next to the existing `client/`-relative imports.)

Then, somewhere in the same file's class body (private static helper or inline at the bottom of the class), add:

```ts
private static reasonToUserMessage(reason: string | undefined, fallbackError: string): string {
    switch (reason) {
        case 'unsupported':
            return 'Service mode is not supported on this platform.';
        case 'uac-declined':
            return 'Administrative privileges were declined. Try again and approve the prompt.';
        case 'handoff-timeout':
            return "Couldn't reach the user session. Make sure ws-scrcpy-web is running for your user, then try again.";
        case 'handoff-no-target':
            return "Couldn't identify a user session to relay the action to.";
        case 'invalid-token':
            return 'Resume token is invalid or expired. Refresh the page and try again.';
        case 'servy-failure':
            return `Service install/uninstall failed: ${fallbackError}`;
        case 'unknown':
        case undefined:
            return `An unexpected error occurred: ${fallbackError}`;
        default:
            return fallbackError;
    }
}
```

- [ ] **Step 2: Gate `onInstallService` on the confirm modal**

Find `private async onInstallService(btn: HTMLButtonElement): Promise<void>` (around line 811). At the very top of the method body, BEFORE `btn.disabled = true`, add:

```ts
const confirmed = await AdminConfirmModal.confirm({ action: 'install service' });
if (!confirmed) return;
```

- [ ] **Step 3: Gate `onUninstallService` on the confirm modal AND add the 5s "still waiting…" affordance**

Find `private async onUninstallService(btn: HTMLButtonElement): Promise<void>` (around line 850). Replace the entire method body with:

```ts
private async onUninstallService(btn: HTMLButtonElement): Promise<void> {
    const confirmed = await AdminConfirmModal.confirm({ action: 'uninstall service' });
    if (!confirmed) return;

    btn.disabled = true;
    const prevText = btn.textContent;
    btn.textContent = 'uninstalling…';

    // The handoff path can take up to 30s while the backend's discover()
    // polls for the new user-session launcher. If it goes past 5s, swap
    // the label so the user knows something is still working.
    const stillWaitingTimeout = setTimeout(() => {
        btn.textContent = 'still waiting for user session…';
    }, 5000);

    try {
        const r = await fetch('/api/service/uninstall', { method: 'POST' });
        const data = (await r.json().catch(() => null)) as ServiceUninstallResponse | null;
        if (!r.ok || !data || data.ok !== true) {
            const errMsg = data && data.ok === false
                ? SettingsModal.reasonToUserMessage(data.reason, data.error)
                : `uninstall failed (${r.status})`;
            this.renderServiceError(errMsg, () => void this.refreshService());
            return;
        }
        if (data.redirectTo) {
            btn.textContent = '→ user mode (uninstall)…';
            setTimeout(() => {
                window.location.href = data.redirectTo!;
            }, 500);
            return;
        }
        await this.refreshService();
    } catch {
        this.renderServiceError("couldn't reach server", () => void this.refreshService());
    } finally {
        clearTimeout(stillWaitingTimeout);
        btn.disabled = false;
        btn.textContent = prevText;
    }
}
```

- [ ] **Step 4: Update `onInstallService` error display to use the reason mapper**

Inside `onInstallService`, find the error block (around line 826-832):

```ts
if (!r.ok || !data || data.ok !== true) {
    const errMsg =
        data && data.ok === false
            ? data.error
            : `install failed (${r.status})`;
    this.renderServiceError(errMsg, () => void this.refreshService());
    return;
}
```

Replace with:

```ts
if (!r.ok || !data || data.ok !== true) {
    const errMsg = data && data.ok === false
        ? SettingsModal.reasonToUserMessage(data.reason, data.error)
        : `install failed (${r.status})`;
    this.renderServiceError(errMsg, () => void this.refreshService());
    return;
}
```

- [ ] **Step 5: Type-check**

```bash
cd C:/Users/jscha/source/repos/ws-scrcpy-web && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Run the existing SettingsModal tests (if any) + workspace tests**

```bash
cd C:/Users/jscha/source/repos/ws-scrcpy-web && npm test
```

Expected: all tests pass (the new AdminConfirmModal tests should run as part of the suite; existing SettingsModal-related tests should still work).

- [ ] **Step 7: Commit**

```bash
cd C:/Users/jscha/source/repos/ws-scrcpy-web && git add src/app/client/SettingsModal.ts && git commit -m "feat(app): gate install/uninstall service on AdminConfirmModal + map reason to user message

- onInstallService and onUninstallService now await
  AdminConfirmModal.confirm({action}) before firing the fetch. Cancel
  → no-op return (no UAC, no API call).
- Failure responses with ok:false are now mapped through a centralized
  reasonToUserMessage helper that turns the contract enum into specific,
  actionable user-facing strings.
- onUninstallService adds a 5-second timer that swaps the button label
  from 'uninstalling…' to 'still waiting for user session…' so the user
  knows the handoff is still working when it takes its full discover
  timeout. Cleared on response.

Closes the §1c.6 admin-confirmation modal item and the user-facing
half of the §1c.5 silent-fail elimination."
```

---

## Phase 2: Integration Verification (sequential, after 1A and 1B)

### Task 2.1: Whole-workspace verification

**Owner:** lead agent (or whichever agent finishes last)

- [ ] **Step 1: Run TypeScript compile check**

```bash
cd C:/Users/jscha/source/repos/ws-scrcpy-web && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 2: Run full vitest suite**

```bash
cd C:/Users/jscha/source/repos/ws-scrcpy-web && npm test
```

Expected: all tests pass (existing 600+ + new ServiceApi reason-coverage tests + new AdminConfirmModal tests).

- [ ] **Step 3: Run cargo workspace tests**

```bash
cd C:/Users/jscha/source/repos/ws-scrcpy-web && cargo test --workspace
```

Expected: PASS. (No Rust changes in this plan, but worth confirming nothing else broke.)

- [ ] **Step 4: Run clippy**

```bash
cd C:/Users/jscha/source/repos/ws-scrcpy-web && cargo clippy --workspace --all-targets -- -D warnings
```

Expected: clean.

- [ ] **Step 5: Webpack build smoke**

```bash
cd C:/Users/jscha/source/repos/ws-scrcpy-web && npm run build
```

Expected: PASS. Confirms the new AdminConfirmModal source compiles into the production bundle.

### Task 2.2: CHANGELOG entry

**Owner:** lead agent

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add Unreleased entries**

Open `CHANGELOG.md`. Under `## [Unreleased]`, add (or extend existing) sections:

```markdown
### Added

- Admin-confirmation modal before clicking Install Service / Uninstall Service. Sets the expectation that a Windows UAC prompt is coming and gives a clean cancel path before the OS dialog fires.

### Fixed

- Service uninstall no longer silently fails for non-admin users. Previously the backend's LocalSystem context would fall through to a direct `runElevated` call after the user-session handoff failed, but PowerShell `Start-Process -Verb RunAs` from LocalSystem has no interactive desktop to show the UAC prompt — the elevation silently never happened and the frontend's "uninstalling…" button hung. Backend now returns a clear 503 + actionable error instead.
- Service-mode failure responses now carry a `reason` discriminator and the frontend maps each variant to a specific actionable message (e.g., "Couldn't reach the user session. Make sure ws-scrcpy-web is running for your user, then try again.") instead of surfacing raw error strings.
- `uninstalling…` button on the Settings modal now swaps to `still waiting for user session…` after 5 seconds so the user can tell the long handoff path is still working, not frozen.
```

(If the Unreleased section already has entries from the minor-tweaks-batch / CSS work, MERGE these into the appropriate `### Added`/`### Fixed` blocks. Don't create duplicate section headings.)

- [ ] **Step 2: Commit**

```bash
cd C:/Users/jscha/source/repos/ws-scrcpy-web && git add CHANGELOG.md && git commit -m "docs(changelog): admin/UAC UX hardening for v0.1.25"
```

---

## Self-Review

**Spec coverage:**

| Spec goal | Plan task |
|---|---|
| Goal 1: silent-fail elimination | Task 1A.2 (cut LocalSystem fallback) + Task 1A.3 (regression-guard test) + Task 1B.3 (frontend reason mapping for clear error display) |
| Goal 2: no UAC attempts from contexts that can't show one | Task 1A.2 |
| Goal 3: admin-confirmation modal | Task 1B.1 (modal class) + Task 1B.2 (tests) + Task 1B.3 (wired into install + uninstall) |
| Goal 4: progress affordance during 30s discover wait | Task 1B.3 (5s setTimeout label swap in onUninstallService) |
| Contract 1 (`ServiceFailureReason`) | Task 0 |
| Contract 2 (`AdminConfirmModal.confirm()`) | Task 1B.1 |
| Contract 3 (no LocalSystem fallthrough) | Task 1A.2 |

**Placeholder scan:** No "TBD" / "TODO later" / vague-handling. Each step has actual code or commands.

**Type/name consistency:**
- `ServiceFailureReason` — defined Task 0, used Tasks 1A.1, 1A.2, 1B.3. All variants spelled identically.
- `AdminConfirmModal.confirm({action})` — defined Task 1B.1, used Task 1B.3. Action union is `'install service' | 'uninstall service'` consistently.
- `reasonToUserMessage` — Task 1B.3 only. Consistent.
- `handoff-timeout` (the new 503 path) — Task 1A.2, asserted in Task 1A.3 test, mapped in Task 1B.3. Consistent.

**Phase-1 parallelism:** Phase 1A and Phase 1B share zero files. After Task 0 lands, both can run in parallel. Phase 2 integration check verifies they agree.

---

## Execution Handoff

This plan is structured for two execution paths:

### Path 1 — `/build-with-agent-team` (parallel, tmux split panes)

User invokes `/build-with-agent-team` from the terminal with this plan path. The lead agent in the tmux pane:
1. Reads this plan file and surfaces the integration contracts (Phase 0 section above).
2. Drives Task 0 to completion synchronously.
3. Spawns two parallel agents — one owning Phase 1A files (`src/server/api/ServiceApi.ts`, `src/server/__tests__/ServiceApi.test.ts`), one owning Phase 1B files (`src/app/client/AdminConfirmModal.ts`, `src/app/client/__tests__/AdminConfirmModal.test.ts`, `src/app/client/SettingsModal.ts`).
4. Coordinates Phase 2 integration check after both finish.

### Path 2 — `superpowers:subagent-driven-development` (sequential, in this session)

I dispatch a fresh subagent per task in order: Task 0 → 1A.1 → 1A.2 → 1A.3 → 1B.1 → 1B.2 → 1B.3 → 2.1 → 2.2. Slower wall clock than Path 1 but doesn't require the user to switch terminals.

Either path works; the plan is structured to be parallel-friendly without requiring it.
