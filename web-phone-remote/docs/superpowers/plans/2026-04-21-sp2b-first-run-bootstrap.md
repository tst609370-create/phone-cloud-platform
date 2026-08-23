# SP2b — First-run bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a fresh Velopack install bootstrap itself on first boot — Node via seeded probe-chain, ADB via auto-install, scrcpy-server via the existing webpack bundle, with a home-page banner for the offline-at-first-boot recovery path.

**Architecture:** `DependencyManager.autoInstallMissing()` is called once after the existing startup `checkAll`; it inspects dep state and calls `update(name)` for any dep where `installedVersion === null && latestVersion !== null`. Launcher scripts gain a two-step Node probe (dependencies first, seed fallback). A new `FirstRunBanner` client component renders on the home page when any dep is in Error or Unknown-with-null-installed state; the banner's Retry button POSTs to a new `/api/dependencies/retry-install` endpoint that re-runs `checkAll` + `autoInstallMissing`.

**Tech Stack:** TypeScript (strict), Vitest, Biome, plain-DOM client classes (existing pattern in `src/app/client/`), raw `http` API handlers (existing pattern in `src/server/api/`).

---

## File map

**New:**
- `src/app/client/FirstRunBanner.ts` — home-page banner component (class with `static async create()` + `getElement()`, matches existing `DependencyPanel` shape).
- `src/style/first-run-banner.css` — banner styles.
- `src/server/__tests__/dependencyManager.autoInstallMissing.test.ts` — unit tests for the new primitive.
- `src/server/__tests__/dependencyApi.retryInstall.test.ts` — unit tests for the new endpoint.

**Modified:**
- `src/server/DependencyManager.ts` — add `autoInstallMissing` method.
- `src/server/api/DependencyApi.ts` — add `/api/dependencies/retry-install` route handler.
- `src/server/index.ts` — chain `autoInstallMissing()` after `checkAll()` in the startup kickoff.
- `src/app/index.ts` — mount the `FirstRunBanner` component + import the new CSS.
- `start.cmd` — add seed fallback to Node probe.
- `start.sh` — add seed fallback to Node probe.
- `CHANGELOG.md` — `Added` entries for autoInstall + banner + retry endpoint; `Changed` entry for launcher probe chain.

**Unchanged:**
- `src/server/DependencyDefinitions.ts` — no changes; Option D still applies unchanged.
- `src/app/client/DependencyPanel.ts` — unchanged; dep panel still shows per-dep progress via existing `/api/dependencies` polling.
- `src/common/DependencyTypes.ts` — no enum or shape changes.

---

## Task 1: `DependencyManager.autoInstallMissing()`

**Files:**
- Create: `src/server/__tests__/dependencyManager.autoInstallMissing.test.ts`
- Modify: `src/server/DependencyManager.ts` (add public method)

- [ ] **Step 1: Write failing tests**

Create `src/server/__tests__/dependencyManager.autoInstallMissing.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DependencyManager } from '../DependencyManager';
import { DependencyStatus } from '../../common/DependencyTypes';

describe('DependencyManager.autoInstallMissing', () => {
    let mgr: DependencyManager;
    let updateSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mgr = new DependencyManager('/tmp/test-deps');
        updateSpy = vi.spyOn(mgr, 'update').mockResolvedValue({
            success: true,
            newVersion: 'stub',
            requiresRestart: false,
        });
    });

    afterEach(() => {
        updateSpy.mockRestore();
    });

    it('installs deps with null installedVersion and non-null latestVersion', async () => {
        const adb = mgr.getByName('adb')!;
        adb.installedVersion = null;
        adb.latestVersion = '35.0.2';
        adb.status = DependencyStatus.Unknown;

        await mgr.autoInstallMissing();

        expect(updateSpy).toHaveBeenCalledWith('adb');
        expect(updateSpy).toHaveBeenCalledTimes(1);
    });

    it('skips deps with null latestVersion (offline case)', async () => {
        const adb = mgr.getByName('adb')!;
        adb.installedVersion = null;
        adb.latestVersion = null;
        adb.status = DependencyStatus.Error;

        await mgr.autoInstallMissing();

        expect(updateSpy).not.toHaveBeenCalled();
    });

    it('skips deps that are already installed (update-path, not install-path)', async () => {
        const nodejs = mgr.getByName('nodejs')!;
        nodejs.installedVersion = '22.11.0';
        nodejs.latestVersion = '24.14.1';
        nodejs.status = DependencyStatus.UpdateAvailable;

        await mgr.autoInstallMissing();

        expect(updateSpy).not.toHaveBeenCalled();
    });

    it('skips deps that are up-to-date', async () => {
        const nodejs = mgr.getByName('nodejs')!;
        nodejs.installedVersion = '24.14.1';
        nodejs.latestVersion = '24.14.1';
        nodejs.status = DependencyStatus.UpToDate;

        await mgr.autoInstallMissing();

        expect(updateSpy).not.toHaveBeenCalled();
    });

    it('installs multiple missing deps sequentially', async () => {
        const adb = mgr.getByName('adb')!;
        adb.installedVersion = null;
        adb.latestVersion = '35.0.2';
        const scrcpy = mgr.getByName('scrcpy-server')!;
        scrcpy.installedVersion = null;
        scrcpy.latestVersion = '3.4';

        await mgr.autoInstallMissing();

        expect(updateSpy).toHaveBeenCalledTimes(2);
        expect(updateSpy).toHaveBeenCalledWith('adb');
        expect(updateSpy).toHaveBeenCalledWith('scrcpy-server');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/__tests__/dependencyManager.autoInstallMissing.test.ts`
Expected: FAIL — `mgr.autoInstallMissing is not a function`.

- [ ] **Step 3: Add the method**

In `src/server/DependencyManager.ts`, ADD this public method after the existing `update()` method (so it sits in the "public state mutators" section, not the checks section):

```ts
    public async autoInstallMissing(): Promise<void> {
        for (const info of this.state.values()) {
            if (info.installedVersion === null && info.latestVersion !== null) {
                log.info(`First-run: auto-installing ${info.name}`);
                await this.update(info.name);
            }
        }
    }
```

Place it immediately after the `public async update(...)` method (before `requestRestart()`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/__tests__/dependencyManager.autoInstallMissing.test.ts`
Expected: all 5 tests PASS.

- [ ] **Step 5: Run full suite to catch regressions**

Run: `npm test`
Expected: all existing tests still pass (3 known flaky `nodePtyResolver.integration.test.ts` failures can be ignored).

- [ ] **Step 6: Biome check**

Run: `npx biome check --write src/server/DependencyManager.ts src/server/__tests__/dependencyManager.autoInstallMissing.test.ts 2>&1 | tail -5`

Re-run tests if biome applied changes.

- [ ] **Step 7: Commit**

```bash
git add src/server/DependencyManager.ts src/server/__tests__/dependencyManager.autoInstallMissing.test.ts
git commit -m "feat(depmgr): autoInstallMissing for first-run bootstrap"
```

---

## Task 2: Wire `autoInstallMissing` into startup

**Files:**
- Modify: `src/server/index.ts` (around line 120, the existing `depManager.checkAll()` kickoff)

No new tests — wiring is a one-line change validated by behavior in subsequent tasks.

- [ ] **Step 1: Locate the existing kickoff**

Read lines 110–130 of `src/server/index.ts`. Find the block that currently reads roughly:

```ts
        // Kick off initial dependency check in background (don't block startup)
        depManager.checkAll().catch((err: Error) => Logger.for('DependencyManager').error('Initial check failed:', err.message));
```

- [ ] **Step 2: Replace with chained autoInstallMissing**

In `src/server/index.ts`, REPLACE the line above with:

```ts
        // Kick off initial dependency check + auto-install in background (don't block startup)
        depManager.checkAll()
            .then(() => depManager.autoInstallMissing())
            .catch((err: Error) => Logger.for('DependencyManager').error('Initial check/install failed:', err.message));
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit 2>&1 | tail -10`
Expected: no errors (other than the pre-existing `libcDetect.test.ts` mock-type issue noted in SP2).

- [ ] **Step 4: Run full suite**

Run: `npm test`
Expected: all tests pass. The index.ts change is runtime-behavior-only and isn't exercised by unit tests.

- [ ] **Step 5: Biome check**

Run: `npx biome check --write src/server/index.ts 2>&1 | tail -5`

- [ ] **Step 6: Commit**

```bash
git add src/server/index.ts
git commit -m "feat(startup): chain autoInstallMissing after initial dep check"
```

---

## Task 3: Launcher probe chain

**Files:**
- Modify: `start.cmd`
- Modify: `start.sh`

No unit tests (shell scripts). Manual verification documented.

- [ ] **Step 1: Read current state of launchers**

Read lines 1–20 of `start.cmd` to see the current Node resolution (post-SP2 Task 2). It should currently read:

```cmd
set "SCRIPT_DIR=%~dp0"
set "NODE=%SCRIPT_DIR%dependencies\node\node.exe"
set "ENTRY=%SCRIPT_DIR%dist\index.js"
set "DEPS_PATH=%SCRIPT_DIR%dependencies"
set "RESTART_MARKER=%DEPS_PATH%\.restart"

:: Ensure node binary exists
if not exist "%NODE%" (
    echo ERROR: Node.js not found at %NODE%
    echo Run the initial setup or place node.exe in dependencies\node\
    pause
    exit /b 1
)
```

Similarly read `start.sh` lines 1–20.

- [ ] **Step 2: Edit `start.cmd` to add seed fallback**

In `start.cmd`, REPLACE the "Ensure node binary exists" block:

```cmd
:: Ensure node binary exists
if not exist "%NODE%" (
    echo ERROR: Node.js not found at %NODE%
    echo Run the initial setup or place node.exe in dependencies\node\
    pause
    exit /b 1
)
```

with:

```cmd
:: Probe chain: dependencies first, then Velopack seed fallback
if not exist "%NODE%" set "NODE=%SCRIPT_DIR%seed\node\node.exe"
if not exist "%NODE%" (
    echo ERROR: Node.js not found at dependencies\node\ or seed\node\
    echo Reinstall the app to restore the bundled Node.
    pause
    exit /b 1
)
```

- [ ] **Step 3: Edit `start.sh` to add seed fallback**

In `start.sh`, REPLACE the "Ensure node binary exists" block:

```bash
# Ensure node binary exists
if [ ! -x "$NODE" ]; then
    echo "ERROR: Node.js not found at $NODE"
    echo "Run the initial setup or place the node binary in dependencies/node/"
    exit 1
fi
```

with:

```bash
# Probe chain: dependencies first, then Velopack seed fallback
if [ ! -x "$NODE" ]; then
    NODE="$SCRIPT_DIR/seed/node/node"
fi
if [ ! -x "$NODE" ]; then
    echo "ERROR: Node.js not found at dependencies/node/ or seed/node/"
    echo "Reinstall the app to restore the bundled Node."
    exit 1
fi
```

- [ ] **Step 4: Verify LF line endings**

Run: `git diff start.cmd start.sh 2>&1 | grep -E "warning|CRLF"`
Expected: no warnings. If `git` reports CRLF, re-save the files with Unix line endings.

- [ ] **Step 5: Verify bash syntax**

Run: `bash -n start.sh`
Expected: no output (syntactically valid).

- [ ] **Step 6: Commit**

```bash
git add start.cmd start.sh
git commit -m "feat(launcher): seed/node/ fallback for Velopack first boot"
```

**Manual verification (after Task 7 lands):**
- Rename `dependencies/node/` → `dependencies/node.bak/`. Pre-place a test Node binary at `seed/node/node.exe`. Run `start.cmd`. Observe server starts (seed fallback works). Restore.

---

## Task 4: Retry-install API endpoint

**Files:**
- Modify: `src/server/api/DependencyApi.ts` (add new route handler)
- Create: `src/server/__tests__/dependencyApi.retryInstall.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/server/__tests__/dependencyApi.retryInstall.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { DependencyApi } from '../api/DependencyApi';
import { DependencyManager } from '../DependencyManager';
import { DependencyStatus } from '../../common/DependencyTypes';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { EventEmitter } from 'events';

function makeMockRes() {
    const res = new EventEmitter() as EventEmitter & {
        statusCode?: number;
        body?: string;
        writeHead: (code: number) => void;
        end: (body: string) => void;
        setHeader: (k: string, v: string) => void;
    };
    res.setHeader = vi.fn();
    res.writeHead = vi.fn((code: number) => {
        res.statusCode = code;
    });
    res.end = vi.fn((body: string) => {
        res.body = body;
    });
    return res;
}

function makeReq(method: string, url: string) {
    return { method, url } as any;
}

describe('DependencyApi retry-install endpoint', () => {
    it('routes POST /api/dependencies/retry-install', async () => {
        const mgr = new DependencyManager('/tmp/test');
        vi.spyOn(mgr, 'checkAll').mockResolvedValue();
        vi.spyOn(mgr, 'autoInstallMissing').mockResolvedValue();
        const api = new DependencyApi(mgr);
        const req = makeReq('POST', '/api/dependencies/retry-install');
        const res = makeMockRes();

        const handled = await api.handle(req, res);

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(mgr.checkAll).toHaveBeenCalled();
        expect(mgr.autoInstallMissing).toHaveBeenCalled();
    });

    it('reports installed deps in response body', async () => {
        const mgr = new DependencyManager('/tmp/test');
        const adb = mgr.getByName('adb')!;
        adb.installedVersion = null;

        vi.spyOn(mgr, 'checkAll').mockImplementation(async () => {
            adb.latestVersion = '35.0.2';
        });
        vi.spyOn(mgr, 'autoInstallMissing').mockImplementation(async () => {
            adb.installedVersion = '35.0.2';
            adb.status = DependencyStatus.UpToDate;
        });

        const api = new DependencyApi(mgr);
        const req = makeReq('POST', '/api/dependencies/retry-install');
        const res = makeMockRes();
        await api.handle(req, res);

        const body = JSON.parse(res.body!);
        expect(body.success).toBe(true);
        expect(body.installed).toContain('adb');
        expect(body.stillMissing).toEqual([]);
    });

    it('reports stillMissing when deps remain null after retry', async () => {
        const mgr = new DependencyManager('/tmp/test');
        const adb = mgr.getByName('adb')!;
        adb.installedVersion = null;
        adb.latestVersion = null;
        adb.status = DependencyStatus.Error;
        adb.errorMessage = 'network timeout';

        vi.spyOn(mgr, 'checkAll').mockResolvedValue();
        vi.spyOn(mgr, 'autoInstallMissing').mockResolvedValue();

        const api = new DependencyApi(mgr);
        const req = makeReq('POST', '/api/dependencies/retry-install');
        const res = makeMockRes();
        await api.handle(req, res);

        const body = JSON.parse(res.body!);
        expect(body.success).toBe(false);
        expect(body.stillMissing).toContain('adb');
        expect(body.errors.adb).toBe('network timeout');
    });

    it('returns 200 even when success is false', async () => {
        const mgr = new DependencyManager('/tmp/test');
        const adb = mgr.getByName('adb')!;
        adb.installedVersion = null;
        adb.status = DependencyStatus.Error;

        vi.spyOn(mgr, 'checkAll').mockResolvedValue();
        vi.spyOn(mgr, 'autoInstallMissing').mockResolvedValue();

        const api = new DependencyApi(mgr);
        const req = makeReq('POST', '/api/dependencies/retry-install');
        const res = makeMockRes();
        await api.handle(req, res);

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body!);
        expect(body.success).toBe(false);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/__tests__/dependencyApi.retryInstall.test.ts`
Expected: FAIL — endpoint routes to 404 Not Found.

- [ ] **Step 3: Add route handler in DependencyApi**

In `src/server/api/DependencyApi.ts`, ADD this route block after the existing `POST /api/dependencies/restart` handler (which sits before the final `res.writeHead(404)` fallthrough):

```ts
            // POST /api/dependencies/retry-install — retry first-run bootstrap
            if (req.method === 'POST' && url === '/api/dependencies/retry-install') {
                const before = new Map<string, { installedVersion: string | null }>();
                for (const info of this.manager.getAll()) {
                    before.set(info.name, { installedVersion: info.installedVersion });
                }
                await this.manager.checkAll();
                await this.manager.autoInstallMissing();
                const installed: string[] = [];
                const stillMissing: string[] = [];
                const errors: Record<string, string> = {};
                for (const info of this.manager.getAll()) {
                    const prev = before.get(info.name);
                    if (prev?.installedVersion === null && info.installedVersion !== null) {
                        installed.push(info.name);
                    }
                    if (info.installedVersion === null) {
                        stillMissing.push(info.name);
                    }
                    if (info.errorMessage) {
                        errors[info.name] = info.errorMessage;
                    }
                }
                const success = stillMissing.length === 0 && Object.keys(errors).length === 0;
                res.writeHead(200);
                res.end(JSON.stringify({ success, installed, stillMissing, errors }));
                return true;
            }
```

Insertion point: in the `try` block of the `handle()` method, AFTER the existing `/restart` branch (around line 49) and BEFORE the fallthrough `res.writeHead(404)` (around line 51).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/__tests__/dependencyApi.retryInstall.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: all tests pass (+4 new, minus 3 known flaky).

- [ ] **Step 6: Biome check**

Run: `npx biome check --write src/server/api/DependencyApi.ts src/server/__tests__/dependencyApi.retryInstall.test.ts 2>&1 | tail -5`

Re-run tests if biome applied changes.

- [ ] **Step 7: Commit**

```bash
git add src/server/api/DependencyApi.ts src/server/__tests__/dependencyApi.retryInstall.test.ts
git commit -m "feat(api): POST /api/dependencies/retry-install endpoint"
```

---

## Task 5: `FirstRunBanner` client component

**Files:**
- Create: `src/app/client/FirstRunBanner.ts`

No unit tests for the client component in this task — DOM-based classes in `src/app/client/` are tested manually in this codebase (see unchanged `DependencyPanel.ts` as an example — no test file). Behavior is covered by manual verification in Task 7.

- [ ] **Step 1: Create the component file**

Create `src/app/client/FirstRunBanner.ts`:

```ts
import type { DependencyInfo } from '../../common/DependencyTypes';
import { DependencyStatus } from '../../common/DependencyTypes';

interface RetryResponse {
    success: boolean;
    installed: string[];
    stillMissing: string[];
    errors: Record<string, string>;
}

export class FirstRunBanner {
    private container: HTMLElement;
    private retryButton: HTMLButtonElement | null = null;

    constructor() {
        this.container = document.createElement('div');
        this.container.className = 'first-run-banner';
        this.container.style.display = 'none';
    }

    static async create(): Promise<FirstRunBanner> {
        const banner = new FirstRunBanner();
        await banner.refresh();
        return banner;
    }

    getElement(): HTMLElement {
        return this.container;
    }

    private async refresh(): Promise<void> {
        try {
            const res = await fetch('/api/dependencies');
            const deps: DependencyInfo[] = await res.json();
            const pending = FirstRunBanner.pendingDeps(deps);
            if (pending.length === 0) {
                this.container.style.display = 'none';
                return;
            }
            this.render(pending);
        } catch {
            this.container.style.display = 'none';
        }
    }

    private static pendingDeps(deps: DependencyInfo[]): DependencyInfo[] {
        return deps.filter(
            (d) =>
                d.status === DependencyStatus.Error ||
                (d.status === DependencyStatus.Unknown && d.installedVersion === null),
        );
    }

    private render(pending: DependencyInfo[]): void {
        const names = pending.map((d) => d.displayName).join(', ');
        this.container.innerHTML = `
            <div class="first-run-banner-inner">
                <span class="first-run-banner-icon">⚠</span>
                <span class="first-run-banner-text">
                    Setup incomplete — ${names} failed to download. Check your network connection.
                </span>
                <button class="first-run-banner-retry" type="button">Retry</button>
            </div>
        `;
        this.retryButton = this.container.querySelector('.first-run-banner-retry');
        this.retryButton?.addEventListener('click', () => this.onRetry());
        this.container.style.display = 'block';
    }

    private async onRetry(): Promise<void> {
        if (!this.retryButton) return;
        const btn = this.retryButton;
        const originalText = btn.textContent ?? 'Retry';
        btn.disabled = true;
        btn.textContent = 'Retrying…';
        try {
            await fetch('/api/dependencies/retry-install', { method: 'POST' });
        } catch {
            // Swallow fetch errors — we refresh below and re-render from truth.
        }
        btn.disabled = false;
        btn.textContent = originalText;
        await this.refresh();
    }
}
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit 2>&1 | grep FirstRunBanner | head -5`
Expected: no output (no type errors in the new file). If errors, fix types inline.

- [ ] **Step 3: Biome check**

Run: `npx biome check --write src/app/client/FirstRunBanner.ts 2>&1 | tail -5`

- [ ] **Step 4: Run full suite**

Run: `npm test`
Expected: all tests pass (no new tests added, but typecheck in CI should be clean).

- [ ] **Step 5: Commit**

```bash
git add src/app/client/FirstRunBanner.ts
git commit -m "feat(client): FirstRunBanner component for offline first-run UX"
```

---

## Task 6: Mount banner + styles on home page

**Files:**
- Create: `src/style/first-run-banner.css`
- Modify: `src/app/index.ts` (import CSS + mount component)

- [ ] **Step 1: Create the CSS file**

Create `src/style/first-run-banner.css`:

```css
.first-run-banner {
    margin: 1rem auto;
    max-width: 960px;
    padding: 0.75rem 1rem;
    border-radius: 6px;
    background-color: var(--warning-color, #ffb74d);
    color: var(--text-color-light, #1a1a1a);
    border: 1px solid var(--section-border-color, rgba(0, 0, 0, 0.15));
    font-size: 14px;
}

.first-run-banner-inner {
    display: flex;
    align-items: center;
    gap: 0.75rem;
}

.first-run-banner-icon {
    font-size: 18px;
    line-height: 1;
    flex-shrink: 0;
}

.first-run-banner-text {
    flex: 1;
}

.first-run-banner-retry {
    flex-shrink: 0;
    padding: 0.35rem 0.85rem;
    border-radius: 4px;
    border: 1px solid var(--section-border-color, rgba(0, 0, 0, 0.25));
    background: transparent;
    color: inherit;
    font-size: 14px;
    cursor: pointer;
}

.first-run-banner-retry:hover:not(:disabled) {
    background-color: rgba(0, 0, 0, 0.08);
}

.first-run-banner-retry:disabled {
    opacity: 0.6;
    cursor: not-allowed;
}
```

The CSS variables (`--warning-color`, `--text-color-light`, `--section-border-color`) are already defined project-wide per the `reference_wsscrcpy_theme_vars` convention; the inline fallbacks (`#ffb74d`, `#1a1a1a`, etc.) are there for safety if the theme vars haven't loaded.

- [ ] **Step 2: Import CSS in app entry**

In `src/app/index.ts`, ADD the import line near the other CSS imports (lines 1–3). After Task 6 the top of the file should read:

```ts
import '../style/app.css';
import '../style/home.css';
import '../style/dependencies.css';
import '../style/first-run-banner.css';
import { HostTracker } from './client/HostTracker';
```

- [ ] **Step 3: Import and mount the component**

In `src/app/index.ts`, ADD the FirstRunBanner import alongside the other client imports (after `DependencyPanel`):

```ts
import { DependencyPanel } from './client/DependencyPanel';
import { FirstRunBanner } from './client/FirstRunBanner';
```

Then in the `window.onload` body, ADD the banner mount AFTER the `pageContainer` is created and BEFORE the `devicesDiv` is appended (so the banner sits at the top of the page content). Find the existing block:

```ts
    const pageContainer = document.createElement('div');
    pageContainer.className = 'page-container';
    document.body.appendChild(pageContainer);

    const devicesDiv = document.createElement('div');
```

INSERT between them:

```ts
    FirstRunBanner.create().then((banner) => {
        pageContainer.insertBefore(banner.getElement(), pageContainer.firstChild);
    });
```

The `insertBefore(..., pageContainer.firstChild)` ensures the banner sits at the top even though the `devicesDiv` / `discoveryPanel` / `DependencyPanel` are appended later with `appendChild`.

- [ ] **Step 4: Build and typecheck**

Run: `npm run build 2>&1 | tail -10`
Expected: webpack compiles successfully. If errors, fix imports or types.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Biome check**

Run: `npx biome check --write src/app/index.ts 2>&1 | tail -5`

Re-run build if biome reordered imports.

- [ ] **Step 7: Commit**

```bash
git add src/style/first-run-banner.css src/app/index.ts
git commit -m "feat(client): mount FirstRunBanner on home page"
```

---

## Task 7: CHANGELOG + final verification

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Verify CHANGELOG structure**

Run: `head -n 30 CHANGELOG.md`
Expected: `[Unreleased]` section exists with `Added` / `Changed` sub-headings (from SP2).

- [ ] **Step 2: Add entries**

In `CHANGELOG.md`, ADD to the `[Unreleased] → Added` section (append below the existing SP2 entries):

```
- `DependencyManager.autoInstallMissing()` — first-run bootstrap primitive that installs any managed dep with `installedVersion === null && latestVersion !== null`. Called once after the startup `checkAll` completes.
- `POST /api/dependencies/retry-install` endpoint — re-runs `checkAll` + `autoInstallMissing` and returns a summary of installed / still-missing / errored deps. Used by the first-run banner's Retry button.
- Home-page first-run banner (`FirstRunBanner`) — renders when any dep is in `Error` state or `Unknown` with null `installedVersion`. Offers a Retry button for offline-at-first-boot recovery.
```

ADD to the `[Unreleased] → Changed` section:

```
- Launcher scripts (`start.cmd`, `start.sh`) now probe `dependencies/node/` first and fall back to `seed/node/` (the Velopack-bundled location) when the dep-managed copy is absent. Supports fresh Velopack installs out of the box.
```

- [ ] **Step 3: Run full test suite one last time**

Run: `npm test 2>&1 | tail -20`
Expected: all tests pass except 3 known flaky integration failures.

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit 2>&1 | tail -10`
Expected: no new errors.

- [ ] **Step 5: Run biome lint on all SP2b-touched files**

Run: `npx biome check src/server/DependencyManager.ts src/server/api/DependencyApi.ts src/server/index.ts src/app/index.ts src/app/client/FirstRunBanner.ts src/style/first-run-banner.css src/server/__tests__/dependencyManager.autoInstallMissing.test.ts src/server/__tests__/dependencyApi.retryInstall.test.ts 2>&1 | tail -10`
Expected: only repo-tolerated warnings (`useNodejsImportProtocol` on node-builtin imports). No new errors.

- [ ] **Step 6: Build to verify the webpack bundle is clean**

Run: `npm run build 2>&1 | tail -5`
Expected: `webpack compiled successfully`.

- [ ] **Step 7: Manual smoke verification (do what you can without interactive UI)**

Confirm:
- `dist/assets/` still contains `scrcpy-server` (webpack bundling unchanged).
- `dist/index.js` built successfully.
- `start.cmd` and `start.sh` still parse via `bash -n start.sh` + visual read.

Skip interactive UI testing — the human operator will manually exercise the banner + probe-chain via SP2's smoke-test style.

- [ ] **Step 8: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): SP2b first-run bootstrap"
```

---

## Self-review checklist

| Spec section | Task(s) | Covered |
|---|---|---|
| §1 In scope #1 (launcher probe chain) | Task 3 | ✓ |
| §1 In scope #2 (autoInstallMissing primitive) | Task 1 | ✓ |
| §1 In scope #3 (home-page banner) | Tasks 5, 6 | ✓ |
| §1 In scope #4 (retry-install endpoint) | Task 4 | ✓ |
| §2 Seed layout | Task 3 (launcher consumes the contract) | ✓ |
| §3 Launcher probe chain (start.cmd) | Task 3 | ✓ |
| §3 Launcher probe chain (start.sh) | Task 3 | ✓ |
| §4 First-run auto-install primitive | Task 1 | ✓ |
| §4 Wiring in index.ts | Task 2 | ✓ |
| §5 Banner component | Task 5 | ✓ |
| §5 Banner visibility predicate | Task 5 (`pendingDeps`) | ✓ |
| §5 Banner placement (home only, top of content) | Task 6 | ✓ |
| §6 Retry endpoint | Task 4 | ✓ |
| §6 Response-shape computation | Task 4 (endpoint body) | ✓ |
| §7 Error handling (offline, flap, disk full, kill-mid-download) | Tasks 1, 4 behavior via update() reuse | ✓ |
| §8 Unit tests | Tasks 1, 4 | ✓ |
| §8 Manual verification | Task 3 footer, Task 7 step 7 | ✓ |
| §9 Implementation surface (new + modified files) | File map + all tasks | ✓ |
| CHANGELOG | Task 7 | ✓ |

**Known minor deviations from spec:**
- Spec §6 referenced `/api/deps/retry-install`. The actual codebase uses prefix `/api/dependencies`, so the plan uses `/api/dependencies/retry-install`. Identical semantics.
- Spec §5 mentioned "path tentative" for the home-page mount — plan resolves this concretely: `src/app/index.ts` `pageContainer` with `insertBefore(..., pageContainer.firstChild)`.
- Spec §9 said the banner file "path tentative" — plan resolves to `src/app/client/FirstRunBanner.ts` (matches existing `DependencyPanel.ts` neighbor).
- CSS is in a new file `src/style/first-run-banner.css` (one-per-component pattern matching existing `dependencies.css`, `home.css`).
