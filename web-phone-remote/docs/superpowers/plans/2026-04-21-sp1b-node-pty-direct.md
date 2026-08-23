# SP1b — Direct node-pty resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swap `@homebridge/node-pty-prebuilt-multiarch` for upstream `node-pty` with our own prebuilt matrix as authoritative source, collapsing the resolver's three-source chain into a two-source chain (local cache → download-if-missing) and adding end-to-end integration test coverage.

**Architecture:** `.npmrc` sets `ignore-scripts=true` globally; `node-pty` becomes an `optionalDependency` so `npm install` succeeds without a C++ toolchain; binaries live in a two-tier layout (persistent cache at `dependencies/node-pty/v{version}/{platform}-{arch}[-{libc}]/` + active copy at `node_modules/node-pty/build/Release/`); resolver copies cache → active on every boot and downloads from GH Releases when cache misses. Upstream node-pty's `lib/utils.js` loader finds the binary via its standard `build/Release/` + `prebuilds/{platform}-{arch}/` iteration, uniformly on all platforms.

**Tech Stack:** Node.js 24, TypeScript, vitest, node-pty 1.1.0, Node built-ins (`fs`, `http`, `crypto`, `child_process`), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-04-21-sp1b-node-pty-direct-design.md`

---

## File Structure

**Create:**
- `.npmrc` — sets `ignore-scripts=true`
- `scripts/fetch-prebuilts.mjs` — standalone pure-JS CLI fetching manifest + tarball + extracting to cache + copying to active
- `src/server/__tests__/nodePtyResolver.integration.test.ts` — local HTTP server fixture + end-to-end download path test
- `src/server/__tests__/setup-fixture.ts` — helper building a tarball fixture from already-populated cache (used by integration test)
- `vitest.globalSetup.ts` — globalSetup hook that runs fetch-prebuilts logic before the first test

**Modify:**
- `package.json` — swap dep `@homebridge/node-pty-prebuilt-multiarch` → `node-pty` under `optionalDependencies`, add `fetch-prebuilts` script
- `vitest.config.ts` (or create if missing) — wire `globalSetup`
- `src/server/NodePtyResolver.ts` — rewrite per spec §2
- `src/server/__tests__/nodePtyResolver.test.ts` — remove obsolete tests, keep helpers
- `src/server/goog-device/mw/RemoteShell.ts:1` — import swap
- `src/server/api/CapabilitiesApi.ts` — only if it references homebridge (grep check)
- `.github/workflows/node-pty-prebuilds.yml` — `cp -r` replacement of explicit cp lines
- `docs/TECHNICAL_GUIDE.md` §18 — rewrite narrative for two-source chain
- `CHANGELOG.md` [Unreleased] — revise SP1 entry
- `README.md` — add `npm run fetch-prebuilts` note under Development section (if section exists; else add one)

**Delete:** nothing as standalone files — removals happen inside rewritten files.

---

## Task 1: Add `.npmrc` with ignore-scripts

**Files:**
- Create: `.npmrc`

- [ ] **Step 1: Create the file**

```
# Globally skip npm install lifecycle scripts. node-pty in particular is an
# optionalDependency whose install script triggers node-gyp rebuild; we
# supply binaries via our own prebuild matrix (SP1/SP1b) instead. Any future
# dep that legitimately needs its install script: run `npm rebuild <pkg>`
# manually or wire an explicit hook in package.json "scripts".
ignore-scripts=true
```

- [ ] **Step 2: Commit**

```bash
git add .npmrc
git commit -m "chore(npm): add .npmrc with ignore-scripts=true

Prepares the repo for SP1b: node-pty becomes an optionalDependency whose
install script triggers node-gyp rebuild (needs C++ toolchain + Python).
We supply binaries via our own prebuilt matrix + resolver download chain,
so install scripts are unnecessary."
```

---

## Task 2: Swap package.json dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Read current dependency block**

Run: `grep -A 2 '"@homebridge' package.json`
Expected: finds the `@homebridge/node-pty-prebuilt-multiarch` line under `dependencies`.

- [ ] **Step 2: Edit `package.json`**

Remove this line from `"dependencies"`:
```json
"@homebridge/node-pty-prebuilt-multiarch": "^0.13.1",
```

Add this block at top level of the JSON (sibling of `dependencies`):
```json
"optionalDependencies": {
  "node-pty": "^1.1.0"
},
```

Add to `"scripts"`:
```json
"fetch-prebuilts": "node scripts/fetch-prebuilts.mjs"
```

- [ ] **Step 3: Run `npm install`**

Run: `npm install`
Expected: clean install, `node_modules/node-pty/` directory exists (package.json + lib/ files), `node_modules/node-pty/build/` does NOT exist (install script was skipped).

- [ ] **Step 4: Verify layout**

Run: `ls node_modules/node-pty/lib/ | head -5`
Expected: `index.js`, `terminal.js`, `unixTerminal.js`, `utils.js`, `windowsTerminal.js` (order varies).

Run: `ls node_modules/node-pty/build 2>&1`
Expected: "No such file or directory".

Run: `ls node_modules/@homebridge 2>&1`
Expected: "No such file or directory" (homebridge uninstalled cleanly).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(deps): swap @homebridge/node-pty-prebuilt-multiarch for node-pty (optional)

Moves to upstream microsoft/node-pty with its standardized multi-path
loader (lib/utils.js). Under optionalDependencies so install succeeds
without a C++ toolchain; .npmrc ignore-scripts prevents node-gyp rebuild
from firing. Binary comes from our prebuilt matrix via the resolver.

Adds npm run fetch-prebuilts script stub (implementation in a follow-up
task)."
```

---

## Task 3: Swap import at RemoteShell call site

**Files:**
- Modify: `src/server/goog-device/mw/RemoteShell.ts:1`

- [ ] **Step 1: Read the current import**

Run: `head -3 src/server/goog-device/mw/RemoteShell.ts`
Expected: first line is `import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch';`

- [ ] **Step 2: Swap the import**

Replace:
```typescript
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch';
```
With:
```typescript
import type { IPty } from 'node-pty';
```

- [ ] **Step 3: Grep for any other homebridge references**

Run: `grep -rn '@homebridge/node-pty' src/ --include="*.ts"`
Expected: should still show the NodePtyResolver.ts hits (those are rewritten in Task 5) and nothing else.

If hits outside `src/server/NodePtyResolver.ts`, swap them to `node-pty` using the same pattern.

- [ ] **Step 4: Commit**

```bash
git add src/
git commit -m "feat(types): import IPty type from node-pty upstream

RemoteShell.ts (and any other non-resolver consumer) now pulls the IPty
type from upstream node-pty instead of the homebridge fork. Functionally
identical surface; sets the stage for the resolver rewrite."
```

---

## Task 4: Write new resolver — helper unit tests (TDD first)

**Files:**
- Modify: `src/server/__tests__/nodePtyResolver.test.ts`

- [ ] **Step 1: Delete obsolete test blocks and write the new helper tests**

Replace the entire contents of `src/server/__tests__/nodePtyResolver.test.ts` with:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as fs from 'fs';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as os from 'os';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as path from 'path';
import {
    resolveNodePty, getNodePty, _resetForTest,
    composePrebuiltKey, verifyChecksum,
    cacheDirHasBinary, nodeModulesReleaseDir,
    type HostInfo,
} from '../NodePtyResolver';

describe('NodePtyResolver — helpers', () => {
    let tmpDir: string;

    beforeEach(() => {
        _resetForTest();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scrcpy-web-resolver-'));
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('composePrebuiltKey produces linux key with libc suffix', () => {
        const key = composePrebuiltKey({
            platform: 'linux', arch: 'x64', libc: 'glibc', nodeAbi: '127',
        }, '1.1.0');
        expect(key).toBe('node-pty-v1.1.0-node-abi127-linux-x64-glibc');
    });

    it('composePrebuiltKey omits libc suffix on win32', () => {
        const key = composePrebuiltKey({
            platform: 'win32', arch: 'arm64', libc: 'glibc', nodeAbi: '127',
        }, '1.1.0');
        expect(key).toBe('node-pty-v1.1.0-node-abi127-win32-arm64');
    });

    it('verifyChecksum returns true for matching SHA256', async () => {
        const filePath = path.join(tmpDir, 'test.bin');
        fs.writeFileSync(filePath, 'hello world');
        const ok = await verifyChecksum(filePath, 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
        expect(ok).toBe(true);
    });

    it('verifyChecksum returns false for mismatching SHA256', async () => {
        const filePath = path.join(tmpDir, 'test.bin');
        fs.writeFileSync(filePath, 'hello world');
        const ok = await verifyChecksum(filePath, '0'.repeat(64));
        expect(ok).toBe(false);
    });

    it('cacheDirHasBinary returns false for missing dir', () => {
        expect(cacheDirHasBinary(path.join(tmpDir, 'nope'))).toBe(false);
    });

    it('cacheDirHasBinary returns false for dir without pty.node', () => {
        fs.writeFileSync(path.join(tmpDir, 'other.node'), 'x');
        expect(cacheDirHasBinary(tmpDir)).toBe(false);
    });

    it('cacheDirHasBinary returns true for dir containing pty.node', () => {
        fs.writeFileSync(path.join(tmpDir, 'pty.node'), 'x');
        expect(cacheDirHasBinary(tmpDir)).toBe(true);
    });

    it('nodeModulesReleaseDir ends with node-pty/build/Release', () => {
        const dir = nodeModulesReleaseDir();
        const tail = dir.split(path.sep).slice(-4).join('/');
        expect(tail).toBe('node_modules/node-pty/build/Release');
    });
});
```

- [ ] **Step 2: Run tests — expected to fail**

Run: `npx vitest run src/server/__tests__/nodePtyResolver.test.ts`
Expected: compilation errors — `cacheDirHasBinary`, `nodeModulesReleaseDir` don't exist yet; tests fail.

- [ ] **Step 3: Commit**

```bash
git add src/server/__tests__/nodePtyResolver.test.ts
git commit -m "test(resolver): update helper unit tests for SP1b rewrite

Replaces the SP1-era test suite. Drops homebridgePrebuildPath tests
(helper being deleted), tryCachedPrebuilt tests (layout changed), old
resolveNodePty happy-path test (relies on pre-populated cache, covered
by integration test in a later task). Adds tests for new helpers:
cacheDirHasBinary, nodeModulesReleaseDir. Tests fail until Task 5
lands the rewrite."
```

---

## Task 5: Rewrite NodePtyResolver.ts

**Files:**
- Modify: `src/server/NodePtyResolver.ts` (wholesale rewrite)

- [ ] **Step 1: Read the current file to preserve any imports you need**

Run: `head -10 src/server/NodePtyResolver.ts`
Expected: imports of `crypto`, `fs`, `path`, `Logger`, `libcDetect`.

- [ ] **Step 2: Replace the entire file with the rewritten version**

Contents of `src/server/NodePtyResolver.ts`:

```typescript
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as crypto from 'crypto';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as fs from 'fs';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as path from 'path';
import { Logger } from './Logger';
import { detectLibc, type LibcFlavor } from './libcDetect';

const log = Logger.for('NodePtyResolver');

export interface NodePtyHandle {
    /** true when a working node-pty module is available */
    available: boolean;
    /** the resolved node-pty module, only present when available === true */
    pty?: typeof import('node-pty');
    /** machine-readable reason when available === false */
    reason?: string;
}

export interface HostInfo {
    platform: 'win32' | 'linux';
    arch: 'x64' | 'arm64';
    libc: LibcFlavor;
    nodeAbi: string;
}

export interface Manifest {
    upstreamVersion: string;
    coveredAbis: string[];
}

let cachedHandle: NodePtyHandle | undefined;
let inflight: Promise<NodePtyHandle> | undefined;

/** Test-only: clear the cached handle so tests can re-run resolution. */
export function _resetForTest(): void {
    cachedHandle = undefined;
    inflight = undefined;
}

export function getNodePty(): NodePtyHandle | undefined {
    return cachedHandle;
}

export function getHostInfo(): HostInfo {
    const platform = (process.platform === 'win32' ? 'win32' : 'linux') as HostInfo['platform'];
    const arch = (process.arch === 'arm64' ? 'arm64' : 'x64') as HostInfo['arch'];
    return {
        platform,
        arch,
        libc: detectLibc(),
        nodeAbi: process.versions.modules,
    };
}

export function composePrebuiltKey(host: HostInfo, upstreamVersion: string): string {
    const libcSuffix = host.platform === 'linux' ? `-${host.libc}` : '';
    return `node-pty-v${upstreamVersion}-node-abi${host.nodeAbi}-${host.platform}-${host.arch}${libcSuffix}`;
}

export async function verifyChecksum(filePath: string, expectedSha256Hex: string): Promise<boolean> {
    return new Promise((resolve) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex').toLowerCase() === expectedSha256Hex.toLowerCase()));
        stream.on('error', () => resolve(false));
    });
}

export function cacheDirHasBinary(dir: string): boolean {
    try {
        return fs.existsSync(path.join(dir, 'pty.node'));
    } catch {
        return false;
    }
}

export function nodeModulesReleaseDir(): string {
    const pkgDir = path.dirname(require.resolve('node-pty/package.json'));
    return path.join(pkgDir, 'build', 'Release');
}

export function cachePathForHost(depsPath: string, upstreamVersion: string, host: HostInfo): string {
    const libcSegment = host.platform === 'linux' ? `-${host.libc}` : '';
    return path.join(
        depsPath,
        'node-pty',
        `v${upstreamVersion}`,
        `${host.platform}-${host.arch}${libcSegment}`,
    );
}

export let RELEASE_URL_BASE = 'https://github.com/bilbospocketses/ws-scrcpy-web/releases/download';
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MANIFEST_CACHE_RELPATH = path.join('node-pty', 'manifest.json');

/** Test-only: override the release URL base for integration tests. */
export function _setReleaseUrlBase(url: string): void {
    RELEASE_URL_BASE = url;
}

export async function loadManifest(depsPath: string): Promise<Manifest | null> {
    const cachedManifestPath = path.join(depsPath, MANIFEST_CACHE_RELPATH);
    try {
        const url = `${RELEASE_URL_BASE}/node-pty-prebuilds-latest/manifest.json`;
        const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (res.ok) {
            const body = await res.json() as Manifest;
            fs.mkdirSync(path.dirname(cachedManifestPath), { recursive: true });
            fs.writeFileSync(cachedManifestPath, JSON.stringify(body, null, 2));
            return body;
        }
        log.info(`manifest fetch returned ${res.status}; trying cached manifest`);
    } catch (err) {
        log.info(`manifest fetch failed: ${(err as Error).message}; trying cached manifest`);
    }
    if (fs.existsSync(cachedManifestPath)) {
        try {
            return JSON.parse(fs.readFileSync(cachedManifestPath, 'utf8')) as Manifest;
        } catch (err) {
            log.info(`cached manifest unreadable: ${(err as Error).message}`);
        }
    }
    return null;
}

export async function downloadAndExtract(
    version: string,
    host: HostInfo,
    cacheDir: string,
): Promise<boolean> {
    const key = composePrebuiltKey(host, version);
    const tarUrl = `${RELEASE_URL_BASE}/node-pty-prebuilds-v${version}/${key}.tar.gz`;
    const sumsUrl = `${RELEASE_URL_BASE}/node-pty-prebuilds-v${version}/SHA256SUMS`;

    try {
        const sumsRes = await fetch(sumsUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!sumsRes.ok) { log.info(`SHA256SUMS fetch failed: ${sumsRes.status}`); return false; }
        const sumsText = await sumsRes.text();
        const sumLine = sumsText.split('\n').find((l) => l.includes(`${key}.tar.gz`));
        if (!sumLine) { log.info(`no checksum entry for ${key}.tar.gz`); return false; }
        const expectedSha = sumLine.split(/\s+/)[0].toLowerCase();

        const tarRes = await fetch(tarUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!tarRes.ok) { log.info(`tarball fetch failed: ${tarRes.status}`); return false; }

        fs.mkdirSync(cacheDir, { recursive: true });
        const tarPath = path.join(cacheDir, `${key}.tar.gz`);
        fs.writeFileSync(tarPath, Buffer.from(await tarRes.arrayBuffer()));

        if (!(await verifyChecksum(tarPath, expectedSha))) {
            log.error(`checksum mismatch for ${key}.tar.gz`);
            fs.rmSync(tarPath, { force: true });
            return false;
        }

        const { execFileSync } = await import('child_process');
        execFileSync('tar', ['-xzf', tarPath, '--strip-components=1', '-C', cacheDir], { stdio: 'inherit' });
        fs.rmSync(tarPath, { force: true });
        return cacheDirHasBinary(cacheDir);
    } catch (err) {
        log.info(`download failed: ${(err as Error).message}`);
        return false;
    }
}

export function copyTreeTo(src: string, dst: string): void {
    fs.mkdirSync(dst, { recursive: true });
    fs.cpSync(src, dst, { recursive: true, force: true });
}

export async function resolveNodePty(depsPath: string): Promise<NodePtyHandle> {
    if (cachedHandle) return cachedHandle;
    if (inflight) return inflight;
    inflight = (async () => {
        const host = getHostInfo();
        log.info(`resolving node-pty for ${host.platform}-${host.arch}-${host.libc}-abi${host.nodeAbi}`);

        const manifest = await loadManifest(depsPath);
        if (!manifest) {
            cachedHandle = { available: false, reason: 'no-manifest' };
            return cachedHandle;
        }
        if (!manifest.coveredAbis.includes(host.nodeAbi)) {
            cachedHandle = {
                available: false,
                reason: `no-prebuilt-for-abi-${host.nodeAbi}-${host.platform}-${host.arch}-${host.libc}`,
            };
            return cachedHandle;
        }
        const version = manifest.upstreamVersion;
        const cacheDir = cachePathForHost(depsPath, version, host);

        if (!cacheDirHasBinary(cacheDir)) {
            log.info(`cache miss at ${cacheDir}; downloading`);
            const ok = await downloadAndExtract(version, host, cacheDir);
            if (!ok) {
                cachedHandle = { available: false, reason: 'download-failed' };
                return cachedHandle;
            }
        } else {
            log.info(`cache hit at ${cacheDir}`);
        }

        try {
            copyTreeTo(cacheDir, nodeModulesReleaseDir());
        } catch (err) {
            log.error(`copy to node_modules failed: ${(err as Error).message}`);
            cachedHandle = { available: false, reason: 'copy-failed' };
            return cachedHandle;
        }

        try {
            const pty = await import('node-pty');
            if (typeof (pty as any).spawn !== 'function') {
                cachedHandle = { available: false, reason: 'import-invalid' };
                return cachedHandle;
            }
            log.info(`node-pty resolved (version ${version}) via ${cacheDirHasBinary(cacheDir) ? 'cache' : 'download'}`);
            cachedHandle = { available: true, pty };
            return cachedHandle;
        } catch (err) {
            log.error(`node-pty import failed: ${(err as Error).message}`);
            cachedHandle = { available: false, reason: 'import-failed' };
            return cachedHandle;
        }
    })();
    return inflight;
}
```

- [ ] **Step 3: Run the helper unit tests — expected to pass now**

Run: `npx vitest run src/server/__tests__/nodePtyResolver.test.ts`
Expected: all helper tests PASS.

- [ ] **Step 4: Run the full TypeScript check to catch any leftover homebridge import**

Run: `npx tsc --noEmit`
Expected: zero errors. If any error mentions `@homebridge/node-pty-prebuilt-multiarch`, go find the consumer and swap its import to `node-pty` (see Task 3 — may need to fix more call sites).

- [ ] **Step 5: Commit**

```bash
git add src/server/NodePtyResolver.ts
git commit -m "feat(resolver): rewrite NodePtyResolver as two-source chain

Drops homebridge fork plumbing entirely. New design:

1. loadManifest fetches latest manifest from GH Releases (falls back
   to cached manifest for offline boot)
2. Computes cachePathForHost under depsPath/node-pty/v{version}/
3. If cacheDirHasBinary, use it. Else downloadAndExtract with
   tar --strip-components=1 flattening the key/ root.
4. copyTreeTo populates node_modules/node-pty/build/Release/ so
   upstream node-pty's lib/utils.js finds our binary uniformly on
   all platforms (no more homebridge layout zoo).
5. import('node-pty'), verify spawn is a function, done.

Failure reasons surface as handle.reason for CapabilitiesApi."
```

---

## Task 6: Check CapabilitiesApi for stale references

**Files:**
- Modify: `src/server/api/CapabilitiesApi.ts` (only if needed)

- [ ] **Step 1: Grep for homebridge mentions**

Run: `grep -n '@homebridge\|homebridge' src/server/api/CapabilitiesApi.ts`
Expected: no hits (CapabilitiesApi calls `getNodePty()` from the resolver; it doesn't import the package directly).

If there ARE hits, open the file and remove them — the endpoint only cares about `handle.available` and `handle.reason`, both of which are still in the NodePtyHandle interface.

- [ ] **Step 2: Run the TypeScript check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

If anything changed:
```bash
git add src/server/api/CapabilitiesApi.ts
git commit -m "chore(api): drop stale homebridge references in CapabilitiesApi"
```

If nothing changed, skip the commit and proceed to Task 7.

---

## Task 7: Build + sanity-check the resolver manually

**Files:** (no file changes; verification step)

- [ ] **Step 1: Build the TS project**

Run: `npm run build`
Expected: clean build, zero errors.

- [ ] **Step 2: Quick manual resolver smoke in a node REPL**

Run:
```bash
node -e "
const { resolveNodePty } = require('./dist/server/NodePtyResolver');
const path = require('path');
resolveNodePty(path.resolve('dependencies')).then(h => {
  console.log('available:', h.available, 'reason:', h.reason);
  process.exit(h.available ? 0 : 1);
});
"
```

Expected: 
- If the existing v1.1.0 release has a matching ABI tarball on GH: `available: true` after a ~2s download. A new cache dir appears at `dependencies/node-pty/v1.1.0/{platform-arch-libc}/` and files appear at `node_modules/node-pty/build/Release/`.
- If the release ABI doesn't match: `available: false reason: no-prebuilt-for-abi-...`

Note: on Windows, the tarball might be incomplete (missing `conpty_console_list.node`) — the `require('node-pty')` call should still succeed because upstream's utils.js falls back to `pty.node`. The `spawn()` call itself would fail on Win10+ conpty path — we deal with that via the workflow fix in Task 14.

- [ ] **Step 3: No commit needed** (no changes).

---

## Task 8: Integration test — setup helpers

**Files:**
- Create: `src/server/__tests__/setup-fixture.ts`

- [ ] **Step 1: Create the fixture-builder helper**

```typescript
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { execFileSync } from 'child_process';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as crypto from 'crypto';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as fs from 'fs';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as path from 'path';

/**
 * Build a tarball named {key}.tar.gz whose contents are everything under
 * `srcDir`, mirroring the matrix workflow's output format (archive has a
 * single top-level dir named after the key; resolver extracts with
 * --strip-components=1).
 *
 * Returns the tarball path and its SHA256 hash.
 */
export function buildFixtureTarball(srcDir: string, key: string, outDir: string): { tarPath: string; sha256: string } {
    fs.mkdirSync(outDir, { recursive: true });
    const stagingDir = path.join(outDir, '_staging');
    const keyDir = path.join(stagingDir, key);
    fs.mkdirSync(keyDir, { recursive: true });
    fs.cpSync(srcDir, keyDir, { recursive: true });

    const tarPath = path.join(outDir, `${key}.tar.gz`);
    execFileSync('tar', ['-czf', tarPath, '-C', stagingDir, key], { stdio: 'inherit' });
    fs.rmSync(stagingDir, { recursive: true, force: true });

    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(tarPath));
    return { tarPath, sha256: hash.digest('hex') };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/__tests__/setup-fixture.ts
git commit -m "test(resolver): add buildFixtureTarball helper for integration tests

Packs an arbitrary directory into a tar.gz named after the prebuilt key,
mirroring the matrix workflow's archive format. Returns tarball path +
SHA256 for fixture HTTP server assembly."
```

---

## Task 9: Integration test — the actual test

**Files:**
- Create: `src/server/__tests__/nodePtyResolver.integration.test.ts`

- [ ] **Step 1: Write the integration test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as http from 'http';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as fs from 'fs';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as os from 'os';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as path from 'path';
import {
    resolveNodePty, _resetForTest, _setReleaseUrlBase,
    composePrebuiltKey, getHostInfo, nodeModulesReleaseDir,
    type Manifest,
} from '../NodePtyResolver';
import { buildFixtureTarball } from './setup-fixture';

describe('NodePtyResolver — integration (download path)', () => {
    let tempDepsPath: string;
    let fixtureDir: string;
    let server: http.Server;
    let serverUrl: string;
    let originalReleaseDirSnapshot: string | null = null;

    beforeEach(async () => {
        _resetForTest();

        // Snapshot node_modules/node-pty/build/Release so we can restore it after the test
        const activeDir = nodeModulesReleaseDir();
        if (fs.existsSync(activeDir)) {
            originalReleaseDirSnapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'nodepty-snapshot-'));
            fs.cpSync(activeDir, originalReleaseDirSnapshot, { recursive: true });
        }

        // Build a fixture: tar up whatever is currently in nodeModulesReleaseDir()
        // (assumes a prior fetch-prebuilts run or a globalSetup populated this)
        if (!fs.existsSync(activeDir) || fs.readdirSync(activeDir).length === 0) {
            throw new Error(
                'Integration test requires node-pty binary already present in node_modules. ' +
                'Run `npm run fetch-prebuilts` or rely on vitest globalSetup.'
            );
        }

        tempDepsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nodepty-integration-'));
        fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodepty-fixture-'));

        const host = getHostInfo();
        const version = '9.9.9';  // fake version so we don't collide with real cache
        const key = composePrebuiltKey(host, version);
        const { tarPath, sha256 } = buildFixtureTarball(activeDir, key, fixtureDir);
        const manifest: Manifest = { upstreamVersion: version, coveredAbis: [host.nodeAbi] };
        const sha256Sums = `${sha256}  ${key}.tar.gz\n`;

        server = http.createServer((req, res) => {
            const url = req.url ?? '';
            if (url.endsWith('/node-pty-prebuilds-latest/manifest.json')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(manifest));
                return;
            }
            if (url.endsWith('/SHA256SUMS')) {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end(sha256Sums);
                return;
            }
            if (url.endsWith(`${key}.tar.gz`)) {
                res.writeHead(200, { 'Content-Type': 'application/gzip' });
                fs.createReadStream(tarPath).pipe(res);
                return;
            }
            res.writeHead(404);
            res.end('not found');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('server.address() returned unexpected value');
        serverUrl = `http://127.0.0.1:${addr.port}`;
        _setReleaseUrlBase(serverUrl);
    });

    afterEach(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        _setReleaseUrlBase('https://github.com/bilbospocketses/ws-scrcpy-web/releases/download');
        try { fs.rmSync(tempDepsPath, { recursive: true, force: true }); } catch {}
        try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
        if (originalReleaseDirSnapshot) {
            const activeDir = nodeModulesReleaseDir();
            try { fs.rmSync(activeDir, { recursive: true, force: true }); } catch {}
            fs.cpSync(originalReleaseDirSnapshot, activeDir, { recursive: true });
            try { fs.rmSync(originalReleaseDirSnapshot, { recursive: true, force: true }); } catch {}
        }
    });

    it('downloads, extracts, places, and loads', async () => {
        const handle = await resolveNodePty(tempDepsPath);
        expect(handle.reason).toBeUndefined();
        expect(handle.available).toBe(true);
        expect(typeof (handle.pty as any).spawn).toBe('function');

        // Cache dir was populated
        const host = getHostInfo();
        const version = '9.9.9';
        const libcSegment = host.platform === 'linux' ? `-${host.libc}` : '';
        const cacheDir = path.join(tempDepsPath, 'node-pty', `v${version}`, `${host.platform}-${host.arch}${libcSegment}`);
        expect(fs.existsSync(path.join(cacheDir, 'pty.node'))).toBe(true);

        // Manifest cached
        expect(fs.existsSync(path.join(tempDepsPath, 'node-pty', 'manifest.json'))).toBe(true);
    });

    it('cache hit skips download on second call', async () => {
        await resolveNodePty(tempDepsPath);
        _resetForTest();

        // Break the server so a second download would fail
        await new Promise<void>((resolve) => server.close(() => resolve()));

        const handle = await resolveNodePty(tempDepsPath);
        expect(handle.available).toBe(true);
    });

    it('returns reason=download-failed when tarball is corrupted', async () => {
        // Swap server to return a bad tarball
        await new Promise<void>((resolve) => server.close(() => resolve()));
        const host = getHostInfo();
        const manifest: Manifest = { upstreamVersion: '9.9.9', coveredAbis: [host.nodeAbi] };
        server = http.createServer((req, res) => {
            const url = req.url ?? '';
            if (url.endsWith('manifest.json')) {
                res.writeHead(200); res.end(JSON.stringify(manifest)); return;
            }
            if (url.endsWith('SHA256SUMS')) {
                res.writeHead(200); res.end('0000000000000000000000000000000000000000000000000000000000000000  bogus\n');
                return;
            }
            res.writeHead(500); res.end('broken');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const addr = server.address() as any;
        _setReleaseUrlBase(`http://127.0.0.1:${addr.port}`);

        const handle = await resolveNodePty(tempDepsPath);
        expect(handle.available).toBe(false);
        expect(handle.reason).toBe('download-failed');
    });
});
```

- [ ] **Step 2: Run the integration test (expect failure; fixture needs globalSetup)**

Run: `npx vitest run src/server/__tests__/nodePtyResolver.integration.test.ts`
Expected: FAIL with "Integration test requires node-pty binary already present in node_modules..." — the pre-fetch dependency is handled in Task 11.

- [ ] **Step 3: Commit**

```bash
git add src/server/__tests__/nodePtyResolver.integration.test.ts
git commit -m "test(resolver): add download-path integration test

Spins up a local HTTP server serving a fixture manifest + SHA256SUMS +
tarball (tarball built from the test host's real prebuilt). Three cases:
- happy path: download → extract → place → require succeeds
- cache hit: second call with server down still resolves
- corrupted tarball: returns reason=download-failed

Fails until Task 11 adds globalSetup to pre-populate node_modules."
```

---

## Task 10: fetch-prebuilts CLI

**Files:**
- Create: `scripts/fetch-prebuilts.mjs`

- [ ] **Step 1: Write the script**

```javascript
#!/usr/bin/env node
// Standalone CLI that downloads our prebuilt node-pty binary for the current
// host and places it into node_modules/node-pty/build/Release/. Pure JS, no
// TypeScript compile step needed.
//
// Invoked by:
//   - `npm run fetch-prebuilts` (explicit, air-gapped setups)
//   - vitest.globalSetup.ts (before test runs)
//   - the main server at boot (via resolveNodePty)
//
// The three callers share logic, but this script duplicates rather than
// imports so it works on a fresh clone before `npm run build`.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELEASE_URL_BASE = process.env.WSSCRCPY_RELEASE_URL_BASE
    ?? 'https://github.com/bilbospocketses/ws-scrcpy-web/releases/download';
const DOWNLOAD_TIMEOUT_MS = 30_000;

function detectLibc() {
    if (process.platform !== 'linux') return 'glibc';
    try {
        const report = process.report?.getReport?.();
        if (report?.header?.glibcVersionRuntime) return 'glibc';
    } catch {}
    if (fs.existsSync('/etc/alpine-release')) return 'musl';
    try {
        const out = execFileSync('ldd', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
        if (/musl/i.test(out)) return 'musl';
    } catch (err) {
        const msg = String(err.stderr ?? '');
        if (/musl/i.test(msg)) return 'musl';
    }
    return 'glibc';
}

function getHostInfo() {
    const platform = process.platform === 'win32' ? 'win32' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    return { platform, arch, libc: detectLibc(), nodeAbi: process.versions.modules };
}

function composePrebuiltKey(host, version) {
    const libcSuffix = host.platform === 'linux' ? `-${host.libc}` : '';
    return `node-pty-v${version}-node-abi${host.nodeAbi}-${host.platform}-${host.arch}${libcSuffix}`;
}

async function verifyChecksum(filePath, expectedHex) {
    return new Promise((resolve) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex').toLowerCase() === expectedHex.toLowerCase()));
        stream.on('error', () => resolve(false));
    });
}

function nodeModulesReleaseDir() {
    const pkgJsonPath = path.join(__dirname, '..', 'node_modules', 'node-pty', 'package.json');
    const pkgDir = path.dirname(pkgJsonPath);
    return path.join(pkgDir, 'build', 'Release');
}

async function main() {
    const depsPath = process.argv[2] ?? path.resolve(__dirname, '..', 'dependencies');
    const host = getHostInfo();
    console.log(`[fetch-prebuilts] host: ${host.platform}-${host.arch}-${host.libc} abi=${host.nodeAbi}`);
    console.log(`[fetch-prebuilts] depsPath: ${depsPath}`);

    const manifestUrl = `${RELEASE_URL_BASE}/node-pty-prebuilds-latest/manifest.json`;
    const manifestRes = await fetch(manifestUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!manifestRes.ok) {
        console.error(`[fetch-prebuilts] manifest fetch failed: ${manifestRes.status}`);
        process.exit(1);
    }
    const manifest = await manifestRes.json();
    const manifestCachePath = path.join(depsPath, 'node-pty', 'manifest.json');
    fs.mkdirSync(path.dirname(manifestCachePath), { recursive: true });
    fs.writeFileSync(manifestCachePath, JSON.stringify(manifest, null, 2));

    if (!manifest.coveredAbis.includes(host.nodeAbi)) {
        console.error(`[fetch-prebuilts] manifest covers ABIs ${manifest.coveredAbis.join(',')}; host needs ${host.nodeAbi}`);
        process.exit(1);
    }

    const version = manifest.upstreamVersion;
    const key = composePrebuiltKey(host, version);
    const libcSegment = host.platform === 'linux' ? `-${host.libc}` : '';
    const cacheDir = path.join(depsPath, 'node-pty', `v${version}`, `${host.platform}-${host.arch}${libcSegment}`);

    if (!fs.existsSync(path.join(cacheDir, 'pty.node'))) {
        const sumsRes = await fetch(`${RELEASE_URL_BASE}/node-pty-prebuilds-v${version}/SHA256SUMS`, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!sumsRes.ok) { console.error(`[fetch-prebuilts] SHA256SUMS fetch failed: ${sumsRes.status}`); process.exit(1); }
        const sumsText = await sumsRes.text();
        const sumLine = sumsText.split('\n').find((l) => l.includes(`${key}.tar.gz`));
        if (!sumLine) { console.error(`[fetch-prebuilts] no checksum for ${key}.tar.gz`); process.exit(1); }
        const expectedSha = sumLine.split(/\s+/)[0].toLowerCase();

        const tarUrl = `${RELEASE_URL_BASE}/node-pty-prebuilds-v${version}/${key}.tar.gz`;
        const tarRes = await fetch(tarUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!tarRes.ok) { console.error(`[fetch-prebuilts] tarball fetch failed: ${tarRes.status}`); process.exit(1); }

        fs.mkdirSync(cacheDir, { recursive: true });
        const tarPath = path.join(cacheDir, `${key}.tar.gz`);
        fs.writeFileSync(tarPath, Buffer.from(await tarRes.arrayBuffer()));
        if (!(await verifyChecksum(tarPath, expectedSha))) {
            console.error('[fetch-prebuilts] checksum mismatch');
            fs.rmSync(tarPath, { force: true });
            process.exit(1);
        }
        execFileSync('tar', ['-xzf', tarPath, '--strip-components=1', '-C', cacheDir], { stdio: 'inherit' });
        fs.rmSync(tarPath, { force: true });
        console.log(`[fetch-prebuilts] downloaded and extracted to ${cacheDir}`);
    } else {
        console.log(`[fetch-prebuilts] cache hit at ${cacheDir}`);
    }

    const activeDir = nodeModulesReleaseDir();
    fs.mkdirSync(activeDir, { recursive: true });
    fs.cpSync(cacheDir, activeDir, { recursive: true, force: true });
    console.log(`[fetch-prebuilts] active location populated: ${activeDir}`);
}

main().catch((err) => {
    console.error('[fetch-prebuilts] unexpected error:', err);
    process.exit(1);
});
```

- [ ] **Step 2: Run it manually (depends on existing v1.1.0 release)**

Run: `rm -rf dependencies/node-pty node_modules/node-pty/build && npm run fetch-prebuilts`
Expected: logs a host line, manifest cached, tarball downloaded, extracted, active dir populated. Exit code 0.

- [ ] **Step 3: Verify active + cache populated**

Run: `ls node_modules/node-pty/build/Release/`
Expected: contains `pty.node` (+ on Windows: `conpty.node`, winpty DLLs/EXE, possibly `conpty/` — depending on if Task 14 matrix re-run has happened yet; incomplete is OK until then).

Run: `ls dependencies/node-pty/`
Expected: `manifest.json` + `v1.1.0/` dir.

- [ ] **Step 4: Commit**

```bash
git add scripts/fetch-prebuilts.mjs
git commit -m "feat(scripts): add fetch-prebuilts CLI for dev + CI

Standalone pure-JS script that fetches the current host's prebuilt
node-pty binary from our GH Releases and places it in node_modules.
Used by: devs for air-gapped setups, vitest globalSetup before tests,
and (by inclusion logic) the server's own resolveNodePty at boot."
```

---

## Task 11: vitest globalSetup wiring

**Files:**
- Create: `vitest.globalSetup.ts`
- Modify: `vitest.config.ts` (create if doesn't exist)

- [ ] **Step 1: Check whether vitest.config.ts exists**

Run: `ls vitest.config.* 2>&1`

Case A (config exists): read it and note the existing structure.
Case B (no config): create `vitest.config.ts` with a minimal default:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globalSetup: ['./vitest.globalSetup.ts'],
    },
});
```

- [ ] **Step 2: Add globalSetup to existing config (if Case A)**

Open `vitest.config.ts`, inside the `test: { ... }` block add:
```typescript
globalSetup: ['./vitest.globalSetup.ts'],
```

- [ ] **Step 3: Write `vitest.globalSetup.ts`**

```typescript
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export async function setup() {
    // Pre-populate node-pty binary so the integration test has a fixture to tar up
    // and so happy-path unit tests can require('node-pty') successfully.
    const activeDir = path.resolve('node_modules', 'node-pty', 'build', 'Release');
    if (fs.existsSync(path.join(activeDir, 'pty.node'))) {
        console.log('[vitest.globalSetup] node-pty binary already present, skipping fetch');
        return;
    }
    console.log('[vitest.globalSetup] fetching node-pty prebuilt...');
    execFileSync('node', ['scripts/fetch-prebuilts.mjs'], { stdio: 'inherit' });
}
```

- [ ] **Step 4: Run the integration test**

Run: `npx vitest run src/server/__tests__/nodePtyResolver.integration.test.ts`
Expected: globalSetup fires (if binary missing), then all 3 tests PASS.

- [ ] **Step 5: Run the full test suite**

Run: `npm test` (or `npx vitest run`)
Expected: all tests pass. Count should be 319 - (removed tests) + (new tests) = roughly 315-320.

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts vitest.globalSetup.ts
git commit -m "test(vitest): add globalSetup that fetches node-pty before tests

Ensures node_modules/node-pty/build/Release/pty.node is present before
any test runs. Integration test uses it as fixture source. Happy-path
tests rely on require('node-pty') succeeding. Idempotent: fast no-op
on subsequent runs."
```

---

## Task 12: Grep for any remaining `@homebridge/node-pty` strings

**Files:** (search, no changes expected)

- [ ] **Step 1: Wide-net search**

Run: `grep -rn '@homebridge/node-pty' --include='*.ts' --include='*.js' --include='*.json' --include='*.md' --include='*.yml' .`
Expected: only hits in `docs/superpowers/specs/` and `docs/superpowers/plans/` historical records, CHANGELOG.md old entries, and `package-lock.json` (acceptable — lockfile reflects uninstalled package correctly).

For any live code/test hit, swap to `node-pty`.

- [ ] **Step 2: Commit (if anything changed)**

```bash
git add .
git commit -m "chore: clean up residual homebridge references"
```

If nothing changed, skip.

---

## Task 13: Workflow cp -r change

**Files:**
- Modify: `.github/workflows/node-pty-prebuilds.yml`

- [ ] **Step 1: Edit the build step**

Find the block starting with `# --build-from-source guarantees the binary lands at build/Release/pty.node` (Task 14 of SP1; around line 90 in the current file). The copy section following looks like:

```bash
PACK_DIR="../artifacts/${KEY}"
mkdir -p "$PACK_DIR"
cp node_modules/node-pty/build/Release/pty.node "$PACK_DIR/"
if [ "$PLATFORM" = "win32" ]; then
  cp node_modules/node-pty/build/Release/conpty.node "$PACK_DIR/" 2>/dev/null || true
  cp node_modules/node-pty/build/Release/*.dll "$PACK_DIR/" 2>/dev/null || true
  cp node_modules/node-pty/build/Release/*.exe "$PACK_DIR/" 2>/dev/null || true
fi
```

Replace with:

```bash
PACK_DIR="../artifacts/${KEY}"
mkdir -p "$PACK_DIR"
# cp -r captures the full build output (pty.node, conpty.node,
# conpty_console_list.node, conpty/ subdir with OpenConsole.exe + conpty.dll,
# winpty DLLs/EXEs on Windows; pty.node on Linux). Future-proof against
# upstream node-pty adding more build artifacts.
cp -r node_modules/node-pty/build/Release/. "$PACK_DIR/"
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/node-pty-prebuilds.yml
git commit -m "fix(ci): recursive copy of build/Release in node-pty matrix

Replaces the explicit cp pty.node + cp conpty.node + cp *.dll + cp *.exe
whitelist with cp -r build/Release/. Captures everything node-pty's
build emits on each platform, including the conpty/ subdir
(OpenConsole.exe + conpty.dll) that Windows 10+ ConPTY requires.

Resolver's tar --strip-components=1 continues to flatten the {key}/
root on the extraction side."
```

---

## Task 14: Push + trigger matrix + wait for release regeneration

**Files:** (no file changes)

- [ ] **Step 1: Push**

Run: `git push origin main`

- [ ] **Step 2: Trigger the workflow with force=true**

Run: `gh workflow run node-pty-prebuilds.yml --ref main --field force=true`

Then: `sleep 4 && gh run list --workflow=node-pty-prebuilds.yml --limit 2`
Expected: new run in_progress.

- [ ] **Step 3: Watch to completion**

Run: `gh run watch <new_run_id> --exit-status`
Expected: success; all 10 rows green; publish fires.

- [ ] **Step 4: Verify release updated**

Run: `gh release view node-pty-prebuilds-v1.1.0 --repo bilbospocketses/ws-scrcpy-web --json assets --jq '.assets[] | .name + " (" + (.size|tostring) + " bytes)"'`
Expected: tarballs larger than before (Windows rows ~1-2 MB larger due to included conpty/ subdir + conpty_console_list.node).

Sanity-check ONE Windows tarball:
```bash
gh release download node-pty-prebuilds-v1.1.0 --pattern '*win32-x64.tar.gz' --dir /tmp/prebuilt-inspect --clobber --repo bilbospocketses/ws-scrcpy-web
tar -tzf /tmp/prebuilt-inspect/node-pty-v1.1.0-node-abi137-win32-x64.tar.gz
```
Expected: lists `pty.node`, `conpty.node`, `conpty_console_list.node`, `conpty/OpenConsole.exe`, `conpty/conpty.dll`, `winpty-agent.exe`, `winpty.dll` (varies by host).

- [ ] **Step 5: No commit needed** (workflow already pushed).

---

## Task 15: Local smoke test — download path

**Files:** (no file changes)

- [ ] **Step 1: Stop any running server**

Run: `netstat -ano | findstr :8000` and kill the node PID if present.

- [ ] **Step 2: Clear cache + active to force full download path**

Run: `rm -rf dependencies/node-pty node_modules/node-pty/build`

- [ ] **Step 3: Start the server**

Run: `npm start &` — or in a separate terminal, `npm start`.
Capture: startup logs.

Expected log lines (in order):
```
[NodePtyResolver] resolving node-pty for win32-x64-glibc-abi137
[NodePtyResolver] cache miss at .../dependencies/node-pty/v1.1.0/win32-x64; downloading
[NodePtyResolver] node-pty resolved (version 1.1.0) via download
```

- [ ] **Step 4: Hit `/api/capabilities` to confirm**

Run: `curl http://localhost:8000/api/capabilities`
Expected: `{"shell":true}`.

- [ ] **Step 5: Open a shell modal end-to-end (interactive)**

In a browser at `http://localhost:8000/`:
- Connect to a device
- Click the shell icon
- Type `ls` and press enter
- Confirm output appears

If shell spawn works → smoke test PASSES. If it fails (error spawning pty), check startup logs, verify all Windows binaries landed in `node_modules/node-pty/build/Release/`.

- [ ] **Step 6: Stop server, no commit needed.**

---

## Task 16: Docs — TECHNICAL_GUIDE §18

**Files:**
- Modify: `docs/TECHNICAL_GUIDE.md` §18

- [ ] **Step 1: Rewrite §18**

Find the existing §18 (around line 1380+, starting with `## 18. Node-Pty Resolver`) and replace the entire section with a description of the new two-source chain. Model paragraphs:

```markdown
## 18. Node-Pty Resolver

### 18.1 Overview

`node-pty` is an optional dependency (`optionalDependencies` in `package.json`)
whose native binary is supplied by our own prebuilt matrix rather than by
`node-gyp rebuild` at `npm install` time. The repo's `.npmrc` sets
`ignore-scripts=true` globally so installing the package never triggers a
compile.

The runtime resolver (`src/server/NodePtyResolver.ts`) supplies the binary at
server startup via a two-source chain:

1. **Local cache** at `dependencies/node-pty/v{upstreamVersion}/{platform}-{arch}[-{libc}]/`.
   Populated by a prior run, or by the installer, or by `npm run fetch-prebuilts`.
2. **Download from GH Releases** if the cache misses. The `node-pty-prebuilds-latest`
   release's `manifest.json` identifies the current version + covered ABIs;
   the versioned release contains the tarball + `SHA256SUMS`. Downloads are
   verified against the checksum before extraction.

On every boot (cache hit OR download), the cache contents are copied to
`node_modules/node-pty/build/Release/`. Upstream `node-pty`'s standard
loader (`lib/utils.js`) finds the binary via its `build/Release/` + `prebuilds/`
iteration — identical behavior on Linux, macOS, and Windows.

### 18.2 Publisher Workflow

A GitHub Actions workflow at `.github/workflows/node-pty-prebuilds.yml`
runs weekly (Mondays 09:00 UTC) and on manual dispatch. [rest of §18.2
unchanged — matrix description, platforms covered, linux-arm64-musl
limitation note]

### 18.3 Libc Detection

[existing section unchanged]
```

(Adapt to the file's actual surrounding sections/numbering. Reuse the
linux-arm64-musl exclusion paragraph verbatim from the current file.)

- [ ] **Step 2: Commit**

```bash
git add docs/TECHNICAL_GUIDE.md
git commit -m "docs(guide): rewrite §18 for SP1b two-source resolver

Replaces the SP1 three-source chain narrative (homebridge fork primary,
disk cache, download fallback) with the new two-source model (local
cache, download-if-missing). Publisher workflow section largely
preserved."
```

---

## Task 17: Docs — CHANGELOG + README

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md`

- [ ] **Step 1: Read CHANGELOG's [Unreleased] block**

Run: `grep -n '## \[' CHANGELOG.md | head -3`
Expected: finds `## [Unreleased]` line.

- [ ] **Step 2: Replace the Changed + Added bullets describing homebridge**

The `## [Unreleased]` section currently contains SP1-era bullets about swapping to `@homebridge/node-pty-prebuilt-multiarch`. Replace them with:

```markdown
### Changed
- Runtime node-pty dependency swapped from `@homebridge/node-pty-prebuilt-multiarch` (`^0.13.1`) back to upstream `node-pty` (`^1.1.0`), moved under `optionalDependencies`. Native binaries supplied by our own prebuilt matrix (SP1) + resolver download chain (SP1b) instead of the homebridge fork's bundled prebuilts. Same public API (`IPty`, `spawn()`); only the import path changed. Addresses SP1 defects where the homebridge loader's platform-specific hard-coded paths (`build/Release/` on Windows, `prebuilds/{platform}-{arch}/` on Linux) made the resolver's Source-3 download fallback fragile.
- `.npmrc` now sets `ignore-scripts=true` globally to prevent `node-pty`'s install script from triggering `node-gyp rebuild`. Binaries arrive via `npm run fetch-prebuilts`, the vitest globalSetup, or the server's own `resolveNodePty()` at boot.

### Added
- `scripts/fetch-prebuilts.mjs` — pure-JS CLI that fetches the current host's node-pty prebuilt from our GH Releases and places it into `node_modules/node-pty/build/Release/`. Wired as `npm run fetch-prebuilts`. Used for air-gapped dev setups and CI pre-fetch.
- `vitest.globalSetup.ts` — invokes the fetch script before any test runs, ensuring `node_modules/node-pty/build/Release/pty.node` exists for happy-path tests and for the new integration test's fixture generation.
- `src/server/__tests__/nodePtyResolver.integration.test.ts` — end-to-end download-path test with a local HTTP fixture server. Covers happy path (download → extract → place → require), cache-hit skipping, and checksum-failure handling. Closes the integration-test gap the SP1 reviewer flagged.
- `src/server/__tests__/setup-fixture.ts` — helper that packs a directory into a tarball named after the prebuilt key, mirroring the matrix workflow's archive format.

### Changed (internal)
- `src/server/NodePtyResolver.ts` rewritten as a two-source chain (local cache → download-if-missing), dropping the SP1 three-source design. Removed `homebridgePrebuildPath`, `tryCachedPrebuilt` (old form), the homebridge-specific copy dance, and the Source-1/Source-2 tier separation. New helpers: `cacheDirHasBinary`, `nodeModulesReleaseDir`, `cachePathForHost`, `loadManifest`, `downloadAndExtract`, `copyTreeTo`. Failure modes surface as typed `reason` strings (`no-manifest`, `no-prebuilt-for-abi-...`, `download-failed`, `copy-failed`, `import-invalid`, `import-failed`) consumed by `CapabilitiesApi` for graceful UI degradation.
- `.github/workflows/node-pty-prebuilds.yml` build step now uses `cp -r build/Release/.` instead of an explicit whitelist. Future-proof against upstream node-pty adding build artifacts; fixes missing `conpty_console_list.node` + `conpty/OpenConsole.exe` + `conpty/conpty.dll` on Windows tarballs.
- Resolver's `downloadAndExtract` uses `tar --strip-components=1` to flatten the `{key}/` root the matrix archive produces (SP1 was missing this, so Source 3 would have failed immediately had anything reached it).
```

- [ ] **Step 3: Add fetch-prebuilts note to README**

Run: `grep -n '## ' README.md | head -10`
Find a Development/Contributing/Building section (or nearest equivalent). Add a one-line bullet:

```markdown
- `npm run fetch-prebuilts` — pre-populate the `node-pty` binary for air-gapped or offline setups. Normally unnecessary: `npm start` and `npm test` do this implicitly on first run.
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md README.md
git commit -m "docs: SP1b CHANGELOG + fetch-prebuilts README note

Replaces the SP1-era Unreleased entries with the final SP1b narrative:
upstream node-pty, two-source resolver, .npmrc, fetch-prebuilts script,
integration test, workflow cp -r fix. Notes the CapabilitiesApi
graceful-degradation reason strings."
```

---

## Task 18: Retire SP1 memory, add SP1b summary

**Files:**
- Modify: `C:/Users/jscha/.claude/projects/C--Users-jscha/memory/MEMORY.md`
- Delete: `C:/Users/jscha/.claude/projects/C--Users-jscha/memory/project_wsscrcpy_sp1_state.md`
- Create: `C:/Users/jscha/.claude/projects/C--Users-jscha/memory/project_wsscrcpy_sp1b.md`

- [ ] **Step 1: Delete the old SP1 state file**

Run: `rm "C:/Users/jscha/.claude/projects/C--Users-jscha/memory/project_wsscrcpy_sp1_state.md"`

- [ ] **Step 2: Create SP1b summary memory**

Write `C:/Users/jscha/.claude/projects/C--Users-jscha/memory/project_wsscrcpy_sp1b.md`:

```markdown
---
name: ws-scrcpy-web SP1b — direct node-pty resolver
description: SP1b swap (drop @homebridge/node-pty-prebuilt-multiarch for upstream node-pty) completed YYYY-MM-DD. Two-source resolver, .npmrc ignore-scripts, fetch-prebuilts script, integration test with local HTTP fixture server, matrix cp -r fix, new v1.1.0 release assets.
type: project
---

## Status

Shipped to `main` YYYY-MM-DD. All tests passing. Matrix re-run produced
complete Windows tarballs (pty.node + conpty.node + conpty_console_list.node
+ conpty/ subdir + winpty bits). Local smoke test confirmed download
path populates cache + active dir and shell modal works end-to-end.

## Why this was needed

SP1 (2026-04-21) shipped a prebuilt matrix + resolver but swapped the
runtime dep to the homebridge fork. End-to-end validation revealed
multiple defects rooted in fighting homebridge's binary-loading layout:

- Windows `windowsPtyAgent.js` hard-codes `require('../build/Release/*.node')`,
  ignoring `prebuild-file-path.js`'s `prebuilds/{platform}-{arch}/` path.
  So the resolver's Source-3 download (which copied to `prebuilds/...`)
  would never be found on Windows.
- On Windows, homebridge's top-level `lib/index.js` sets `exports.native = null`
  without triggering a lazy native load — so Source 1's `typeof pty.spawn === 'function'`
  check passed regardless of whether the binary was actually present/working.
- Resolver's tarball extraction didn't strip the `{key}/` root produced by
  the matrix workflow — Source 3 would have failed on Linux too, had the
  homebridge-layer-1 import ever failed.
- Matrix tarballs on Windows were incomplete (missing `conpty_console_list.node`
  + `conpty/` subdir).

## What SP1b does

Drops homebridge entirely. Uses upstream `microsoft/node-pty`'s standardized
`lib/utils.js` loader which iterates `build/Release/`, `build/Debug/`,
`prebuilds/{platform}-{arch}/` uniformly on all platforms.

Resolver is now a two-source chain (local cache + download-if-missing)
instead of three. Fewer code paths, unified platform behavior, no
homebridge indirection. Source 3 bug corpus resolved: `--strip-components=1`
on extract, `cp -r build/Release/.` in workflow for complete tarballs.

## Key file locations

- Spec: `docs/superpowers/specs/2026-04-21-sp1b-node-pty-direct-design.md`
- Plan: `docs/superpowers/plans/2026-04-21-sp1b-node-pty-direct.md`
- Resolver: `src/server/NodePtyResolver.ts`
- Integration test: `src/server/__tests__/nodePtyResolver.integration.test.ts`
- CLI: `scripts/fetch-prebuilts.mjs`
- Workflow: `.github/workflows/node-pty-prebuilds.yml`

## Follow-up ideas

- Bundle the current-platform prebuilt into the Velopack installer (SP3)
  so first-boot has zero download. Already on the roadmap.
- Revisit `linux-arm64-musl` coverage once GH Actions resolves actions/runner#801.

## How to apply

Keep this memory until SP2 (dep-manager polish) kicks off. At that point
SP1+SP1b can be consolidated into a single "SP1 shipped" memory if it's
getting cluttered.
```

(Fill in `YYYY-MM-DD` with today's date when committing.)

- [ ] **Step 3: Update MEMORY.md index**

Open `MEMORY.md` and:
1. Remove the `project_wsscrcpy_sp1_state.md` line
2. Add (near the other `project_wsscrcpy_*` entries):
```
- [ws-scrcpy-web SP1b](project_wsscrcpy_sp1b.md) — direct node-pty resolver (homebridge fork dropped); two-source chain + integration test; shipped YYYY-MM-DD
```

- [ ] **Step 4: Update `project_wsscrcpy_todo.md`**

Move the SP1 bullet to the "Shelved / Completed" section and add a note:

```markdown
- **SP1 + SP1b (node-pty prebuilt matrix + direct resolver):** SHIPPED YYYY-MM-DD. See `project_wsscrcpy_sp1b.md`. Moves to Shelved.
```

- [ ] **Step 5: No code commit for memory** (memory lives outside the repo).

---

## Task 19: Final smoke + cleanup verification

**Files:** (verification)

- [ ] **Step 1: Run the full test suite one more time**

Run: `npx vitest run`
Expected: all tests pass (target ~315-320 total).

- [ ] **Step 2: Run the TS type check**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Run the build**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 4: Fresh-clone simulation**

Run:
```bash
rm -rf dependencies/node-pty node_modules/node-pty/build
npm start
```

In another shell:
```bash
curl http://localhost:8000/api/capabilities
```

Expected: shell: true, resolver logs the download path.

- [ ] **Step 5: Kill server.**

- [ ] **Step 6: Verify git log**

Run: `git log --oneline main ^HEAD~20 -20`
Expected: sees all SP1b commits in reverse order.

- [ ] **Step 7: Push any uncommitted work**

Run: `git status`
If clean, done. If any stragglers, commit + push.

---

## Done

At this point:
- Homebridge fork uninstalled, upstream node-pty in place with no rebuild at install
- Resolver two-source chain working end-to-end on Windows (and other platforms by symmetry)
- Integration test covering download-path with a local HTTP fixture
- Matrix producing complete Windows tarballs
- v1.1.0 release regenerated with fat tarballs
- Docs, CHANGELOG, and memory aligned

SP1+SP1b is rocking complete. Next session: SP2 (dep-manager polish) per `docs/superpowers/specs/2026-04-21-installer-docker-roadmap.md`.
