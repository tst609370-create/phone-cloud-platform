# SP2 — Dep-manager polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten `DependencyManager` / `Config` / launcher scripts so the same server binary runs correctly in dev, Velopack, and Docker, and gate Node auto-updates on node-pty prebuilt availability.

**Architecture:** Pure-function refactor of `Config` dependency-path resolution (strict in prod, dev-only fallback with `package.json`-sibling tell). Restart signal upgraded to write marker at `<depsPath>/.restart` and exit with code `75` — launcher scripts watch both. `getDependencyDefinitions(depsPath)` factory captures `depsPath` so `nodejs.checkLatest()` can filter candidate LTS releases against `NodePtyResolver.loadManifest()`'s `coveredAbis`. Never auto-downgrade is enforced in `resolveStatus`.

**Tech Stack:** TypeScript (strict), Vitest, Biome; existing `src/server/Logger.ts` for all logging; existing `src/server/NodePtyResolver.ts` for manifest access.

---

## File map

**New:**
- `src/server/__tests__/config.depsPath.test.ts` — tests for the new resolution function.

**Modified:**
- `src/server/Config.ts` — extract `resolveDependenciesPath()` pure function; wire into `getInstance()`.
- `src/server/DependencyManager.ts` — marker path change, exit code `75`, `Logger.for('DependencyManager')` coverage, never-auto-downgrade in `resolveStatus`, pass `depsPath` to `getDependencyDefinitions`.
- `src/server/DependencyDefinitions.ts` — accept `depsPath` in factory; add `NODE_LTS_ABI` map + `parseNodeMajor()` helper; implement Option D in `nodejs.checkLatest()` with WARN logging via `Logger.for('DependencyDefinitions')`.
- `src/server/__tests__/dependencyManager.test.ts` — extend with requestRestart test + no-downgrade test + factory-signature update.
- `src/server/__tests__/dependencyDefinitions.test.ts` — extend with Option D tests + factory-signature update.
- `start.cmd` — resolve marker from `%DEPS_PATH%`; loop on marker OR exit code 75.
- `start.sh` — mirror of the above.
- `CHANGELOG.md` — one `Added` line + one `Changed` line under `[Unreleased]`.

**Unchanged:**
- `src/common/DependencyTypes.ts` (no enum or shape changes)
- `src/app/client/DependencyPanel.ts` (UI unchanged per spec §1)
- `src/server/api/DependencyApi.ts` (endpoint contract unchanged)

---

## Task 1: Extract `resolveDependenciesPath()` pure function in Config

**Files:**
- Modify: `src/server/Config.ts:99-100`
- Test: `src/server/__tests__/config.depsPath.test.ts` (new)

- [ ] **Step 1: Write the failing test file**

Create `src/server/__tests__/config.depsPath.test.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveDependenciesPath } from '../Config';

describe('resolveDependenciesPath', () => {
    let tmpRoot: string;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cfg-'));
    });

    afterEach(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('returns DEPS_PATH env when set', () => {
        const result = resolveDependenciesPath(
            { DEPS_PATH: '/explicit/deps' },
            {},
            '/any/entry.js',
            () => true,
        );
        expect(result).toBe('/explicit/deps');
    });

    it('env wins over fileConfig and dev fallback', () => {
        const result = resolveDependenciesPath(
            { DEPS_PATH: '/env/deps' },
            { dependenciesPath: '/config/deps' },
            '/any/entry.js',
            () => true,
        );
        expect(result).toBe('/env/deps');
    });

    it('returns fileConfig.dependenciesPath when env is absent', () => {
        const result = resolveDependenciesPath(
            {},
            { dependenciesPath: '/from/config' },
            '/any/entry.js',
            () => true,
        );
        expect(result).toBe('/from/config');
    });

    it('falls back to ../dependencies when package.json sibling exists (dev)', () => {
        const entry = path.join(tmpRoot, 'dist', 'index.js');
        fs.mkdirSync(path.dirname(entry), { recursive: true });
        fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
        const result = resolveDependenciesPath({}, {}, entry);
        expect(result).toBe(path.resolve(tmpRoot, 'dependencies'));
    });

    it('throws a clear error when no source resolves and dev tell is missing', () => {
        expect(() =>
            resolveDependenciesPath({}, {}, '/no/package/json/here/dist/index.js', () => false),
        ).toThrow(/DEPS_PATH is not set/);
    });

    it('error message names DEPS_PATH and config.json', () => {
        try {
            resolveDependenciesPath({}, {}, '/no/pkg/dist/index.js', () => false);
        } catch (e) {
            const msg = (e as Error).message;
            expect(msg).toContain('DEPS_PATH');
            expect(msg).toContain('config.json');
        }
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/__tests__/config.depsPath.test.ts`
Expected: FAIL — `resolveDependenciesPath` is not exported from `../Config`.

- [ ] **Step 3: Add `resolveDependenciesPath` export to Config.ts**

In `src/server/Config.ts`, ADD this function immediately after the `FlatConfig` interface definition (around line 30, before `export class Config`):

```ts
/**
 * Pure resolver: produces the absolute dependencies-folder path the app should
 * manage. Priority: DEPS_PATH env → config.json → dev fallback → hard-fail.
 * Dev fallback only triggers when a package.json is a sibling of the entry
 * script's parent directory (the unambiguous "we are in a dev checkout" tell).
 */
export function resolveDependenciesPath(
    env: NodeJS.ProcessEnv,
    fileConfig: FlatConfig,
    entryScript: string,
    exists: (p: string) => boolean = fs.existsSync,
): string {
    if (env['DEPS_PATH']) return env['DEPS_PATH'];
    if (fileConfig.dependenciesPath) return fileConfig.dependenciesPath;
    const entryDir = path.dirname(entryScript);
    const devCandidate = path.resolve(entryDir, '..', 'dependencies');
    const devTell = path.resolve(entryDir, '..', 'package.json');
    if (exists(devTell)) return devCandidate;
    throw new Error(
        'DEPS_PATH is not set and no dependencies path is configured. ' +
        'Set the DEPS_PATH environment variable (the launcher script does this automatically) ' +
        'or add "dependenciesPath" to config.json. ' +
        'Expected location example: <installFolder>/dependencies/',
    );
}
```

- [ ] **Step 4: Wire the new resolver into `getInstance()`**

In `src/server/Config.ts`, REPLACE lines 99–100:

```ts
            const dependenciesPath = process.env['DEPS_PATH'] ?? fileConfig.dependenciesPath
                ?? path.resolve(path.dirname(process.argv[1] || '.'), '..', 'dependencies');
```

with:

```ts
            const dependenciesPath = resolveDependenciesPath(
                process.env,
                fileConfig,
                process.argv[1] ?? '.',
            );
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/server/__tests__/config.depsPath.test.ts`
Expected: PASS — all 6 tests.

- [ ] **Step 6: Run full suite to catch regressions**

Run: `npm test`
Expected: all existing tests (311+) still pass.

- [ ] **Step 7: Commit**

```bash
git add src/server/Config.ts src/server/__tests__/config.depsPath.test.ts
git commit -m "feat(config): strict depsPath resolution with dev-only fallback"
```

---

## Task 2: Launcher scripts — marker at `$DEPS_PATH/.restart`, loop on exit 75

**Files:**
- Modify: `start.cmd`
- Modify: `start.sh`

No unit tests (shell scripts). Manual verification documented at the end of this task.

- [ ] **Step 1: Edit `start.cmd`**

In `start.cmd`, REPLACE line 10:

```cmd
set "RESTART_MARKER=%SCRIPT_DIR%.restart"
```

with:

```cmd
set "RESTART_MARKER=%DEPS_PATH%\.restart"
```

Then REPLACE lines 35–43 (the post-exit check block):

```cmd
:: Check if restart was requested
if exist "%RESTART_MARKER%" (
    del "%RESTART_MARKER%"
    :: Clean up old node binary if update just happened
    if exist "%NODE%.old" del "%NODE%.old"
    echo Restarting...
    timeout /t 2 /nobreak >nul
    goto loop
)
```

with:

```cmd
:: Check if restart was requested — marker file OR exit code 75
if exist "%RESTART_MARKER%" (
    del "%RESTART_MARKER%"
    if exist "%NODE%.old" del "%NODE%.old"
    echo Restarting (marker)...
    timeout /t 2 /nobreak >nul
    goto loop
)
if "%EXIT_CODE%"=="75" (
    if exist "%NODE%.old" del "%NODE%.old"
    echo Restarting (exit 75)...
    timeout /t 2 /nobreak >nul
    goto loop
)
```

- [ ] **Step 2: Edit `start.sh`**

In `start.sh`, REPLACE line 8:

```bash
RESTART_MARKER="$SCRIPT_DIR/.restart"
```

with:

```bash
RESTART_MARKER="$DEPS_PATH/.restart"
```

Then REPLACE lines 26–32 (the post-exit check):

```bash
    # Check if restart was requested
    if [ -f "$RESTART_MARKER" ]; then
        rm -f "$RESTART_MARKER"
        echo "Restarting..."
        sleep 2
        continue
    fi
```

with:

```bash
    # Check if restart was requested — marker file OR exit code 75
    if [ -f "$RESTART_MARKER" ]; then
        rm -f "$RESTART_MARKER"
        echo "Restarting (marker)..."
        sleep 2
        continue
    fi
    if [ "$EXIT_CODE" -eq 75 ]; then
        echo "Restarting (exit 75)..."
        sleep 2
        continue
    fi
```

- [ ] **Step 3: Manual verification on Windows**

```bash
# In a separate bash window inside the repo:
npm run build
# Then in cmd.exe:
start.cmd
# Wait for server to boot, then in another window:
type nul > dependencies\.restart
# Observe: server should exit, "Restarting (marker)..." should appear, server boots again.
# Then stop it (Ctrl+C).
```

If the server does NOT loop on the marker, check `%DEPS_PATH%` was set (it should be set by `start.cmd` line 11).

- [ ] **Step 4: Manual verification of exit-code loop (optional)**

Temporarily patch `dist/index.js` to call `process.exit(75)` immediately on startup. Run `start.cmd`. Observe "Restarting (exit 75)..." looping. Revert the patch.

- [ ] **Step 5: Commit**

```bash
git add start.cmd start.sh
git commit -m "feat(launcher): watch \$DEPS_PATH/.restart marker and exit code 75"
```

---

## Task 3: `DependencyManager.requestRestart` — new marker path + exit code 75

**Files:**
- Modify: `src/server/DependencyManager.ts:150-155`
- Test: `src/server/__tests__/dependencyManager.test.ts` (extend)

- [ ] **Step 1: Write failing tests (extend existing test file)**

In `src/server/__tests__/dependencyManager.test.ts`, ADD these imports at the top of the file (the `describe` block is already present):

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { vi } from 'vitest';
```

Also update the existing import line to include `afterEach` and `beforeEach`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
```

ADD this `describe` block at the end of the file (after the existing tests):

```ts
describe('DependencyManager.requestRestart', () => {
    let tmpDir: string;
    let exitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-dm-'));
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(
            ((code?: number) => { throw new Error(`exit:${code}`); }) as never,
        );
    });

    afterEach(() => {
        exitSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writes marker at depsPath/.restart (not dirname(depsPath)/.restart)', () => {
        const mgr = new DependencyManager(tmpDir);
        expect(() => mgr.requestRestart()).toThrow(/exit:/);
        expect(fs.existsSync(path.join(tmpDir, '.restart'))).toBe(true);
        expect(fs.existsSync(path.join(path.dirname(tmpDir), '.restart'))).toBe(false);
    });

    it('exits with code 75', () => {
        const mgr = new DependencyManager(tmpDir);
        expect(() => mgr.requestRestart()).toThrow('exit:75');
    });

    it('marker body contains a timestamp marker', () => {
        const mgr = new DependencyManager(tmpDir);
        try { mgr.requestRestart(); } catch { /* expected */ }
        const body = fs.readFileSync(path.join(tmpDir, '.restart'), 'utf-8');
        expect(body).toMatch(/^restart-requested-\d+$/);
    });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx vitest run src/server/__tests__/dependencyManager.test.ts`
Expected: the three new tests FAIL. The "writes marker at depsPath/.restart" test fails because today's code writes at `dirname(depsPath)`. The "exits with code 75" test fails because today's code exits with code 0.

- [ ] **Step 3: Update `requestRestart`**

In `src/server/DependencyManager.ts`, REPLACE lines 150–155:

```ts
    public requestRestart(): void {
        const projectRoot = path.dirname(this.depsPath);
        const markerPath = path.join(projectRoot, '.restart');
        fs.writeFileSync(markerPath, `restart-requested-${Date.now()}`);
        process.exit(0);
    }
```

with:

```ts
    public requestRestart(): void {
        const markerPath = path.join(this.depsPath, '.restart');
        fs.writeFileSync(markerPath, `restart-requested-${Date.now()}`);
        process.exit(75);
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/__tests__/dependencyManager.test.ts`
Expected: all tests PASS (existing 5 + new 3).

- [ ] **Step 5: Commit**

```bash
git add src/server/DependencyManager.ts src/server/__tests__/dependencyManager.test.ts
git commit -m "feat(depmgr): restart marker at depsPath/.restart + exit code 75"
```

---

## Task 4: Add `Logger.for('DependencyManager')` coverage

**Files:**
- Modify: `src/server/DependencyManager.ts` (add logger + log lines)

No new tests — Logger behavior is covered by `src/server/__tests__/` broadly; we verify by eye that log calls are in the right places and fit the existing pattern (`src/server/ScrcpyConnection.ts:22` shape).

- [ ] **Step 1: Add logger at module scope**

In `src/server/DependencyManager.ts`, ADD this import near the other imports:

```ts
import { Logger } from './Logger';
```

ADD this line after the imports and before the `const execFileAsync = promisify(execFile);` line:

```ts
const log = Logger.for('DependencyManager');
```

- [ ] **Step 2: Log the `checkAll` aggregate**

In `src/server/DependencyManager.ts`, REPLACE the `checkAll` method (around line 82–91):

```ts
    public async checkAll(): Promise<void> {
        // Check all installed versions first
        for (const def of this.definitions) {
            await this.checkInstalled(def.name);
        }
        // Then check all latest versions
        for (const def of this.definitions) {
            await this.checkLatest(def.name);
        }
    }
```

with:

```ts
    public async checkAll(): Promise<void> {
        for (const def of this.definitions) {
            await this.checkInstalled(def.name);
        }
        for (const def of this.definitions) {
            await this.checkLatest(def.name);
        }
        const updates = Array.from(this.state.values())
            .filter((i) => i.status === DependencyStatus.UpdateAvailable)
            .map((i) => i.name);
        const upToDate = Array.from(this.state.values())
            .filter((i) => i.status === DependencyStatus.UpToDate).length;
        const summary = updates.length === 0
            ? `all ${upToDate} up-to-date`
            : `${updates.length} update available (${updates.join(', ')}), ${upToDate} up-to-date`;
        log.info(`Dependency check complete: ${summary}`);
    }
```

- [ ] **Step 3: Log `checkLatest` failures at WARN**

In `src/server/DependencyManager.ts`, REPLACE the catch block of `checkLatest` (around line 77–79):

```ts
        } catch (err) {
            info.status = DependencyStatus.Error;
            info.errorMessage = err instanceof Error ? err.message : String(err);
        }
```

with:

```ts
        } catch (err) {
            info.status = DependencyStatus.Error;
            info.errorMessage = err instanceof Error ? err.message : String(err);
            log.warn(`Latest-version check failed for ${name}: ${info.errorMessage}`);
        }
```

- [ ] **Step 4: Log update start, complete, failure**

In `src/server/DependencyManager.ts`, in the `update()` method (around line 93–148):

After the line `info.status = DependencyStatus.Updating;` (around line 100), ADD:

```ts
        const fromVersion = info.installedVersion ?? 'not installed';
```

After the line `if (!info.latestVersion) { throw new Error('Could not determine latest version'); }` (around line 108–110), ADD:

```ts
        log.info(`Updating ${name}: ${fromVersion} → ${info.latestVersion}`);
```

After the line `info.status = DependencyStatus.UpToDate;` (around line 128), ADD:

```ts
        log.info(`Updated ${name} to ${version}${def.requiresRestart ? ' (restart queued)' : ''}`);
```

In the catch block, AFTER `info.errorMessage = err instanceof Error ? err.message : String(err);` (around line 133–134), ADD:

```ts
            log.error(`Update ${name} failed: ${info.errorMessage}`);
```

- [ ] **Step 5: Log restart request**

In `src/server/DependencyManager.ts`, in the `requestRestart` method (which you modified in Task 3), ADD a log line BEFORE `process.exit(75)`:

```ts
    public requestRestart(): void {
        const markerPath = path.join(this.depsPath, '.restart');
        fs.writeFileSync(markerPath, `restart-requested-${Date.now()}`);
        log.info(`Restart requested; writing marker at ${markerPath} and exiting with code 75`);
        process.exit(75);
    }
```

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: all tests pass. `DependencyManager.requestRestart` tests may log during test runs — that's expected, they still pass.

- [ ] **Step 7: Commit**

```bash
git add src/server/DependencyManager.ts
git commit -m "feat(depmgr): Logger.for coverage at medium granularity"
```

---

## Task 5: Add `NODE_LTS_ABI` map and `parseNodeMajor` helper

**Files:**
- Modify: `src/server/DependencyDefinitions.ts`
- Test: `src/server/__tests__/dependencyDefinitions.test.ts` (extend)

- [ ] **Step 1: Write failing tests**

In `src/server/__tests__/dependencyDefinitions.test.ts`, ADD to the imports line:

```ts
import { getPlatform, getArch, getDependencyDefinitions, NODE_LTS_ABI, parseNodeMajor } from '../DependencyDefinitions';
```

ADD these two `describe` blocks at the end of the file:

```ts
describe('parseNodeMajor', () => {
    it('parses leading-v version strings', () => {
        expect(parseNodeMajor('v24.14.1')).toBe(24);
    });

    it('parses bare version strings', () => {
        expect(parseNodeMajor('22.11.0')).toBe(22);
    });

    it('returns NaN for garbage input', () => {
        expect(parseNodeMajor('not-a-version')).toBeNaN();
    });
});

describe('NODE_LTS_ABI', () => {
    it('covers known LTS majors with string ABI values', () => {
        // These ABIs are documented in process.versions.modules across Node releases.
        expect(NODE_LTS_ABI[20]).toBe('115');
        expect(NODE_LTS_ABI[22]).toBe('127');
        expect(NODE_LTS_ABI[24]).toBe('137');
    });

    it('does not include non-LTS majors', () => {
        expect(NODE_LTS_ABI[21]).toBeUndefined();
        expect(NODE_LTS_ABI[23]).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/__tests__/dependencyDefinitions.test.ts`
Expected: FAIL — `NODE_LTS_ABI` and `parseNodeMajor` are not exported.

- [ ] **Step 3: Add the map and helper**

In `src/server/DependencyDefinitions.ts`, ADD these exports immediately after the `getArch` function (around line 19, before the `DependencyDefinition` interface):

```ts
/**
 * Node major version → ABI number (`process.versions.modules`).
 * ABI is stable within a major; it changes only across majors.
 * Keys are Node major numbers; values are string-form ABI numbers
 * so they can be compared directly against Manifest.coveredAbis.
 *
 * Add new LTS majors here as they are released AND as our node-pty
 * prebuilt matrix ships a release for them.
 */
export const NODE_LTS_ABI: Record<number, string> = {
    20: '115',
    22: '127',
    24: '137',
};

/** Parses the leading major number from a Node version string like "v24.14.1". */
export function parseNodeMajor(version: string): number {
    const m = version.match(/^v?(\d+)\./);
    return m ? Number.parseInt(m[1], 10) : Number.NaN;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/__tests__/dependencyDefinitions.test.ts`
Expected: all tests PASS (existing + new 4).

- [ ] **Step 5: Commit**

```bash
git add src/server/DependencyDefinitions.ts src/server/__tests__/dependencyDefinitions.test.ts
git commit -m "feat(depdef): NODE_LTS_ABI map and parseNodeMajor helper"
```

---

## Task 6: Thread `depsPath` through `getDependencyDefinitions`

**Files:**
- Modify: `src/server/DependencyDefinitions.ts:42` (factory signature)
- Modify: `src/server/DependencyManager.ts:27` (pass depsPath to factory)
- Modify: `src/server/__tests__/dependencyDefinitions.test.ts` (update existing call sites)

- [ ] **Step 1: Update existing tests to the new signature (will fail until implementation)**

In `src/server/__tests__/dependencyDefinitions.test.ts`, REPLACE every call to `getDependencyDefinitions()` with `getDependencyDefinitions('/tmp/test-deps')`. Three existing tests use this call — update all three.

- [ ] **Step 2: Run tests to verify they fail at a specific error**

Run: `npx vitest run src/server/__tests__/dependencyDefinitions.test.ts`
Expected: FAIL — `getDependencyDefinitions` takes 0 arguments.

- [ ] **Step 3: Change factory signature**

In `src/server/DependencyDefinitions.ts`, REPLACE line 42:

```ts
export function getDependencyDefinitions(): DependencyDefinition[] {
```

with:

```ts
export function getDependencyDefinitions(depsPath: string): DependencyDefinition[] {
```

(Note: `depsPath` is currently unused inside the function body. That's OK — it will be consumed in Task 7. Suppressing the lint for this one task would add noise; the parameter will be used by the next task and the CI linter allows unused params named `_something`. Since `depsPath` will be used imminently, leave it as-is. If the biome unused-parameter lint fires, add a `// biome-ignore lint/correctness/noUnusedFunctionParameters: used in Task 7` comment.)

- [ ] **Step 4: Update `DependencyManager` constructor to pass depsPath**

In `src/server/DependencyManager.ts`, REPLACE line 27:

```ts
        this.definitions = getDependencyDefinitions();
```

with:

```ts
        this.definitions = getDependencyDefinitions(depsPath);
```

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: all tests pass (signature change is compatible with all call sites now).

- [ ] **Step 6: Commit**

```bash
git add src/server/DependencyDefinitions.ts src/server/DependencyManager.ts src/server/__tests__/dependencyDefinitions.test.ts
git commit -m "refactor(depdef): thread depsPath through factory"
```

---

## Task 7: Option D — filter `nodejs.checkLatest` by manifest coverage

**Files:**
- Modify: `src/server/DependencyDefinitions.ts` (nodejs.checkLatest body; add module-scope logger)
- Test: `src/server/__tests__/dependencyDefinitions.test.ts` (add Option D tests)

- [ ] **Step 1: Write failing tests**

In `src/server/__tests__/dependencyDefinitions.test.ts`, ADD these imports at the top (merge into existing import lines as appropriate):

```ts
import { vi } from 'vitest';
import * as NodePtyResolver from '../NodePtyResolver';
```

ADD this `describe` block at the end of the file:

```ts
describe('nodejs.checkLatest (Option D gating)', () => {
    const ltsReleases = [
        { version: 'v26.0.0', lts: 'Theta' },
        { version: 'v24.14.1', lts: 'Krypton' },
        { version: 'v22.11.0', lts: 'Jod' },
        { version: 'v20.15.0', lts: 'Iron' },
    ];

    let fetchSpy: ReturnType<typeof vi.spyOn>;
    let manifestSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
            new Response(JSON.stringify(ltsReleases), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );
    });

    afterEach(() => {
        fetchSpy.mockRestore();
        manifestSpy?.mockRestore();
    });

    function getNodejsDef() {
        const defs = getDependencyDefinitions('/tmp/test-deps');
        const d = defs.find((x) => x.name === 'nodejs');
        if (!d) throw new Error('nodejs definition missing');
        return d;
    }

    it('returns newest LTS covered by manifest', async () => {
        manifestSpy = vi.spyOn(NodePtyResolver, 'loadManifest').mockResolvedValue({
            upstreamVersion: '1.1.0',
            coveredAbis: ['115', '127', '137'],  // 20, 22, 24 — not 26
        });
        const def = getNodejsDef();
        expect(await def.checkLatest()).toBe('24.14.1');
    });

    it('returns the next-newest LTS when latest has no prebuilt', async () => {
        manifestSpy = vi.spyOn(NodePtyResolver, 'loadManifest').mockResolvedValue({
            upstreamVersion: '1.1.0',
            coveredAbis: ['115', '127'],  // 20, 22 only
        });
        const def = getNodejsDef();
        expect(await def.checkLatest()).toBe('22.11.0');
    });

    it('returns null when no LTS in manifest coverage', async () => {
        manifestSpy = vi.spyOn(NodePtyResolver, 'loadManifest').mockResolvedValue({
            upstreamVersion: '1.1.0',
            coveredAbis: ['100'],  // no known LTS matches
        });
        const def = getNodejsDef();
        expect(await def.checkLatest()).toBeNull();
    });

    it('falls back to unfiltered latest when manifest is null', async () => {
        manifestSpy = vi.spyOn(NodePtyResolver, 'loadManifest').mockResolvedValue(null);
        const def = getNodejsDef();
        expect(await def.checkLatest()).toBe('26.0.0');
    });

    it('ignores Node majors not in NODE_LTS_ABI (skips unknown)', async () => {
        // If a release appears that we don't know the ABI for, skip it.
        // Here 26 is pretended-unknown (we remove it from the map for this test).
        const original = { ...NODE_LTS_ABI };
        delete (NODE_LTS_ABI as Record<number, string>)[26];
        try {
            manifestSpy = vi.spyOn(NodePtyResolver, 'loadManifest').mockResolvedValue({
                upstreamVersion: '1.1.0',
                coveredAbis: ['115', '127', '137'],
            });
            const def = getNodejsDef();
            expect(await def.checkLatest()).toBe('24.14.1');
        } finally {
            Object.assign(NODE_LTS_ABI, original);
        }
    });
});
```

(Note: the last test mutates `NODE_LTS_ABI`. Since Node 26 isn't in the map anyway, the mutation is effectively a no-op in practice, but the test pattern documents the policy — unknown majors are dropped even if their ABI theoretically matches.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/__tests__/dependencyDefinitions.test.ts`
Expected: all five new tests FAIL — `nodejs.checkLatest` today ignores the manifest.

- [ ] **Step 3: Add a module-scope logger**

In `src/server/DependencyDefinitions.ts`, ADD this import near the other imports:

```ts
import { Logger } from './Logger';
import { loadManifest } from './NodePtyResolver';
```

ADD this line after the imports (before the `execFileAsync` line):

```ts
const log = Logger.for('DependencyDefinitions');
```

- [ ] **Step 4: Rewrite `nodejs.checkLatest` to implement Option D**

In `src/server/DependencyDefinitions.ts`, REPLACE the nodejs `checkLatest` (around lines 58–63):

```ts
            checkLatest: async () => {
                const res = await fetch('https://nodejs.org/dist/index.json');
                const releases = (await res.json()) as { version: string; lts: string | false }[];
                const lts = releases.find((r) => r.lts !== false);
                return lts ? lts.version.replace(/^v/, '') : null;
            },
```

with:

```ts
            checkLatest: async () => {
                const res = await fetch('https://nodejs.org/dist/index.json');
                const releases = (await res.json()) as { version: string; lts: string | false }[];
                const ltsReleases = releases.filter((r) => r.lts !== false);
                if (ltsReleases.length === 0) return null;

                const manifest = await loadManifest(depsPath);
                if (!manifest) {
                    log.warn('Prebuilt manifest unavailable; Node update gating skipped');
                    return ltsReleases[0].version.replace(/^v/, '');
                }

                const covered = new Set(manifest.coveredAbis);
                const candidates = ltsReleases.filter((r) => {
                    const major = parseNodeMajor(r.version);
                    const abi = NODE_LTS_ABI[major];
                    return abi !== undefined && covered.has(abi);
                });
                if (candidates.length === 0) return null;

                const filteredLatest = candidates[0];
                const unfilteredLatest = ltsReleases[0];
                if (filteredLatest.version !== unfilteredLatest.version) {
                    log.warn(
                        `Node ${unfilteredLatest.version.replace(/^v/, '')} available but no matching ` +
                        `node-pty prebuilt; staying on filter max ${filteredLatest.version.replace(/^v/, '')}`,
                    );
                }
                return filteredLatest.version.replace(/^v/, '');
            },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/server/__tests__/dependencyDefinitions.test.ts`
Expected: all tests PASS (existing + new 5).

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: all 311+ tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/server/DependencyDefinitions.ts src/server/__tests__/dependencyDefinitions.test.ts
git commit -m "feat(depdef): gate nodejs.checkLatest on node-pty manifest coverage"
```

---

## Task 8: Never-auto-downgrade rule in `resolveStatus`

**Files:**
- Modify: `src/server/DependencyManager.ts:157-170`
- Test: `src/server/__tests__/dependencyManager.test.ts` (extend)

- [ ] **Step 1: Write failing test**

In `src/server/__tests__/dependencyManager.test.ts`, ADD this `describe` block at the end of the file:

```ts
describe('DependencyManager resolveStatus — never auto-downgrade', () => {
    it('keeps UpToDate when installed version is newer than latest filtered', async () => {
        // Simulate a state where installed (from real Node) is 26.0.0 but
        // the filtered latest (gated on prebuilts) is 24.14.1.
        const mgr = new DependencyManager('/tmp/test-deps');
        const info = mgr.getByName('nodejs')!;
        info.installedVersion = '26.0.0';
        info.latestVersion = '24.14.1';
        // @ts-expect-error — invoke private method for unit test
        mgr.resolveStatus(info);
        expect(info.status).toBe(DependencyStatus.UpToDate);
    });

    it('produces UpdateAvailable when installed is older than latest', () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        const info = mgr.getByName('nodejs')!;
        info.installedVersion = '22.11.0';
        info.latestVersion = '24.14.1';
        // @ts-expect-error — invoke private method for unit test
        mgr.resolveStatus(info);
        expect(info.status).toBe(DependencyStatus.UpdateAvailable);
    });

    it('produces UpToDate when versions are equal', () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        const info = mgr.getByName('nodejs')!;
        info.installedVersion = '24.14.1';
        info.latestVersion = '24.14.1';
        // @ts-expect-error — invoke private method for unit test
        mgr.resolveStatus(info);
        expect(info.status).toBe(DependencyStatus.UpToDate);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/__tests__/dependencyManager.test.ts`
Expected: the "keeps UpToDate" test FAILS — current `resolveStatus` would return `UpToDate` anyway via the `cmp >= 0` branch for the installed-newer case, so actually this test MAY PASS today. Verify behavior: `compareVersions('26.0.0', '24.14.1')` returns `1`, so `cmp >= 0` → `UpToDate`. The test DOES pass today by accident. The new test documents the guarantee; we'll add an explicit INFO log and make the intent-expressed-in-code cleaner.

If the test passes as-is: proceed to Step 3 anyway to make the no-downgrade rule explicit with logging. Re-running tests post-implementation confirms no regression.

- [ ] **Step 3: Rewrite `resolveStatus` to make the never-downgrade explicit**

In `src/server/DependencyManager.ts`, REPLACE the `resolveStatus` method (around lines 157–170):

```ts
    private resolveStatus(info: DependencyInfo): void {
        if (info.installedVersion === null) {
            info.status = DependencyStatus.Unknown;
            return;
        }
        if (info.latestVersion === null) {
            // Installed but don't know latest — keep as unknown
            info.status = DependencyStatus.Unknown;
            return;
        }
        const cmp = compareVersions(info.installedVersion, info.latestVersion);
        info.status = cmp >= 0 ? DependencyStatus.UpToDate : DependencyStatus.UpdateAvailable;
        info.errorMessage = undefined;
    }
```

with:

```ts
    private resolveStatus(info: DependencyInfo): void {
        if (info.installedVersion === null) {
            info.status = DependencyStatus.Unknown;
            return;
        }
        if (info.latestVersion === null) {
            info.status = DependencyStatus.Unknown;
            return;
        }
        const cmp = compareVersions(info.installedVersion, info.latestVersion);
        if (cmp > 0) {
            // Never auto-downgrade: filter (e.g. Option D prebuilt gating) can
            // report a "latest" older than what the user has. Leave them alone.
            info.status = DependencyStatus.UpToDate;
            info.errorMessage = undefined;
            log.info(
                `Installed ${info.name} ${info.installedVersion} is newer than filtered latest ` +
                `${info.latestVersion}; staying put`,
            );
            return;
        }
        info.status = cmp === 0 ? DependencyStatus.UpToDate : DependencyStatus.UpdateAvailable;
        info.errorMessage = undefined;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/__tests__/dependencyManager.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/server/DependencyManager.ts src/server/__tests__/dependencyManager.test.ts
git commit -m "feat(depmgr): never auto-downgrade; explicit UpToDate when installed > latest"
```

---

## Task 9: CHANGELOG + final verification

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Verify CHANGELOG structure**

Run: `head -n 30 CHANGELOG.md`
Expected: existing `[Unreleased]` section with `Added` / `Changed` / `Fixed` subheadings (matching the project's Keep-a-Changelog convention from `feedback_changelog_sop`).

- [ ] **Step 2: Add entries**

In `CHANGELOG.md`, ADD to the `[Unreleased] → Added` section:

```
- Logger coverage in `DependencyManager` at medium granularity (update start/complete, checkAll aggregate, restart requested, errors).
- Node auto-update gating against the node-pty prebuilt manifest (Option D): `nodejs.checkLatest` only offers LTS versions we have prebuilts for; silently skips newer majors until the matrix catches up.
- Launcher scripts (`start.cmd`, `start.sh`) now also loop on process exit code 75, in addition to the `.restart` marker.
```

ADD to the `[Unreleased] → Changed` section:

```
- `DependencyManager.requestRestart` now writes the `.restart` marker at `<depsPath>/.restart` (was `dirname(depsPath)/.restart`) and exits with code 75 (was 0). Launcher scripts updated to read the marker from `$DEPS_PATH/.restart` and also loop on exit code 75. This unbreaks the marker path under Velopack's `<installFolder>/current/` layout and lets supervisors (systemd, Docker restart policies) distinguish intentional restart from crash.
- `Config.dependenciesPath` resolution is now strict: `DEPS_PATH` environment variable wins, then `config.json` `dependenciesPath`, then a dev-only fallback that triggers only when a sibling `package.json` is present. Production deployments (Velopack, Docker) must set `DEPS_PATH`. A clear startup error names the env var and config key if no source resolves.
- Never-auto-downgrade rule: when the (possibly filtered) latest version is older than the installed version, status stays `UpToDate` with an explanatory INFO log.
```

- [ ] **Step 3: Run the full test suite one more time**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 4: Run the typecheck and linter**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx biome check src/server/Config.ts src/server/DependencyManager.ts src/server/DependencyDefinitions.ts src/server/__tests__/`
Expected: no issues (or only pre-existing ignores that were not introduced here).

- [ ] **Step 5: Manual smoke verification**

1. `npm run build`
2. `npm start` — server should boot normally using the dev fallback (`../dependencies` relative to `dist/index.js`).
3. Open the dep panel UI, click "Check for updates", observe:
   - Console shows `[DependencyManager] Dependency check complete: ...`
   - If the user's Node is older than the filtered latest, "Update available" appears.
   - If a newer-than-filtered LTS exists, console shows the Option D WARN.
4. If an update is offered, click it, then click "Restart now". Server should exit with code 75; `npm start` does NOT loop (it's `node` directly, not the launcher). Manual verification of the loop requires `start.cmd` or `start.sh`.

- [ ] **Step 6: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): SP2 dep-manager polish"
```

---

## Self-review checklist (for plan author)

| Spec section | Task(s) | OK? |
|---|---|---|
| §1 Scope | All tasks scoped to the 4 in-scope items; SP2b/SP3/SP4/UI explicitly not touched. | ✓ |
| §2 Layout and depsPath | Task 1 (resolver function) + Task 2 (launchers set DEPS_PATH — already present, untouched) | ✓ |
| §3 Restart signal | Task 2 (launchers) + Task 3 (requestRestart) + Task 4 (restart-request log line) | ✓ |
| §4 Option D | Task 5 (ABI map) + Task 6 (thread depsPath) + Task 7 (filter + WARN) + Task 8 (never-downgrade) | ✓ |
| §5 Logging | Task 4 (DependencyManager) + Task 7 (DependencyDefinitions WARN) + Task 8 (resolveStatus INFO) | ✓ |
| §6 Testing | New tests land in Tasks 1, 3, 5, 7, 8; manual verification in Task 2 and Task 9. | ✓ |
| CHANGELOG | Task 9 | ✓ |

**Spec drift notes:**
- Spec §6 proposed three new test files. Plan instead extends existing `dependencyManager.test.ts` and `dependencyDefinitions.test.ts` (matching project convention — one test file per module). Only `config.depsPath.test.ts` is new because there was no prior `config.test.ts`. Acceptable drift — the spec's test coverage matrix is intact.
- Plan uses factory-captures-depsPath (Task 6) rather than `checkLatest(depsPath)` param. Cleaner, doesn't change the `DependencyDefinition` interface shape. Minor drift from spec pseudocode in §4; behavior identical.
