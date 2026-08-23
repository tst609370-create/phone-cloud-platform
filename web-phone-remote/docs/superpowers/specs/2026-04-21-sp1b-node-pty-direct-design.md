# SP1b — Direct node-pty resolver (drop homebridge fork)

**Status:** Draft — brainstormed 2026-04-21 in the ws-scrcpy-web session that shipped SP1 (v1.1.0 matrix release).

**Context:** SP1 shipped a node-pty prebuilt matrix + GH Releases publisher, swapping the runtime dep from `microsoft/node-pty` to `@homebridge/node-pty-prebuilt-multiarch` to avoid the `node-gyp rebuild` toolchain requirement at install time. End-to-end validation of the resolver's download path (memory step 7) revealed multiple defects rooted in fighting homebridge's binary-loading layout (lazy `require` of hard-coded `build/Release/` paths on Windows, `prebuilds/{platform}-{arch}/` on Linux, ABI-in-filename rename, per-platform divergence). SP1b replaces the homebridge indirection with a direct-use model: our prebuilt matrix against upstream `microsoft/node-pty` is the single source of truth.

---

## Goals

1. A first-run-successful resolver that downloads, extracts, and activates a working node-pty binary with no platform-specific branches around which path homebridge expects.
2. A single canonical binary layout — upstream node-pty's standardized `build/Release/{pty,conpty,conpty_console_list}.node` + sibling DLLs / EXEs / subdirs.
3. End-to-end integration test coverage of the download path, addressing the SP1 reviewer's gap.
4. Unchanged API surface for call sites — `src/server/goog-device/mw/RemoteShell.ts` continues importing an `IPty` type and calling `pty.spawn(...)`.

## Non-goals

- Replacing SP1's matrix workflow (kept; only the copy step changes from explicit whitelist to `cp -r`).
- Replacing the GH Releases pipeline (kept; only tarball contents become complete).
- Adding a multi-version node-pty support (one upstream version per release, same as SP1).
- Handling installer-bundled prebuilts (that's SP3/SP4; this spec just requires the binary-location convention they'll write into).

---

## 1. Runtime dependency

Swap `@homebridge/node-pty-prebuilt-multiarch` → `node-pty` upstream. Placed under `optionalDependencies` so `npm install` succeeds even when no C++ toolchain / Python is present.

Upstream `node-pty@1.1.x` ships a standardized loader at `lib/utils.js`:

```js
var dirs = ['build/Release', 'build/Debug', 'prebuilds/' + process.platform + '-' + process.arch];
var relative = ['..', '.'];
for each dir × each relative: try require
```

No Windows-special hard-coded paths. Identical mechanism on Linux, macOS, Windows. Our binaries at `<nodeModules>/node-pty/build/Release/{name}.node` satisfy the first iteration.

### `.npmrc`

New file at repo root:

```
ignore-scripts=true
```

Applies to all dependencies. Prevents node-pty's `install` / `postinstall` scripts from firing a `node-gyp rebuild`. If some future dep legitimately needs its install script, handle via `npm rebuild <pkg>` or an explicit hook in our own `scripts`. No current deps rely on scripts except node-pty.

### Import sites

Change six imports:

- `src/server/NodePtyResolver.ts` — rewritten; removes `@homebridge/*` import entirely
- `src/server/goog-device/mw/RemoteShell.ts:1` — `import type { IPty } from 'node-pty'`
- `src/server/api/CapabilitiesApi.ts` — no type import (interface check is runtime-only); verify
- `src/server/__tests__/nodePtyResolver.test.ts` — update type imports
- Any other test referencing `@homebridge/*` — grep + replace

---

## 2. Resolver (`src/server/NodePtyResolver.ts`)

### Public API (unchanged shape)

```ts
export interface NodePtyHandle {
    available: boolean;
    pty?: typeof import('node-pty');
    reason?: string;
}

export function resolveNodePty(depsPath: string): Promise<NodePtyHandle>;
export function getNodePty(): NodePtyHandle | undefined;
export function _resetForTest(): void;
```

### Algorithm

```
resolveNodePty(depsPath):
  if cachedHandle: return cachedHandle
  if inflight: return inflight
  inflight = async:
    host = getHostInfo()           // {platform, arch, libc, nodeAbi}
    manifest = await loadManifest(depsPath)   // cached at depsPath/node-pty/manifest.json
    if !manifest.coveredAbis.includes(host.nodeAbi):
      return { available: false, reason: 'no-prebuilt-for-abi-...' }
    version = manifest.upstreamVersion
    cacheDir = depsPath/node-pty/v{version}/{platform}-{arch}[-{libc}]/

    // Source 1: local cache
    if cacheDirHasBinary(cacheDir):
      copyTreeTo(cacheDir, nodeModulesReleaseDir())
      return importOrFail()

    // Source 2: download
    try downloadAndExtract(version, host, cacheDir)
    if cacheDirHasBinary(cacheDir):
      copyTreeTo(cacheDir, nodeModulesReleaseDir())
      return importOrFail()

    return { available: false, reason: 'download-failed' }
```

### Helpers

- `getHostInfo()` — unchanged from SP1.
- `composePrebuiltKey(host, version)` — unchanged.
- `loadManifest(depsPath)` — fetches `<RELEASE_URL_BASE>/node-pty-prebuilds-latest/manifest.json`. Caches at `depsPath/node-pty/manifest.json`. On fetch failure, falls back to cached manifest (offline boot). If neither: `{available: false, reason: 'no-manifest'}`.
- `downloadAndExtract(version, host, cacheDir)` — downloads tarball + SHA256SUMS to a temp path, verifies checksum, extracts with `tar -xzf <tar> --strip-components=1 -C <cacheDir>`. `--strip-components=1` flattens the `{key}/` root the workflow produces. Cleans up temp tar file.
- `verifyChecksum(path, expectedHex)` — unchanged.
- `cacheDirHasBinary(dir)` — `fs.existsSync(path.join(dir, 'pty.node'))`. Minimal check; actual validity comes from `require()` succeeding.
- `copyTreeTo(src, dst)` — recursive copy. Use `fs.cpSync(src, dst, { recursive: true })` (Node 16.7+). Creates dst dir if needed. Idempotent.
- `nodeModulesReleaseDir()` — `path.dirname(require.resolve('node-pty/package.json')) + '/build/Release'`.
- `importOrFail()` — `require('node-pty')`. If `typeof pty.spawn !== 'function'` return `{available: false, reason: 'import-invalid'}`; else `{available: true, pty}`.

### Failure modes / reasons

- `no-manifest` — never reached GH Releases, no cached manifest
- `no-prebuilt-for-abi-X-Y-Z-W` — manifest does not cover current ABI/platform
- `download-failed` — network error, 404, checksum mismatch
- `import-invalid` — `require('node-pty')` returned something without `spawn` (package corrupted)

`CapabilitiesApi` maps any `available: false` → `{shell: false}` — graceful UI degradation already present.

---

## 3. Binary locations

### Persistent cache (authoritative, survives `npm ci`)

```
<depsPath>/node-pty/
  ├── manifest.json           # cached copy of latest manifest
  └── v{upstreamVersion}/
      ├── win32-x64/
      │   ├── pty.node
      │   ├── conpty.node
      │   ├── conpty_console_list.node
      │   ├── winpty-agent.exe
      │   ├── winpty.dll
      │   └── conpty/
      │       ├── OpenConsole.exe
      │       └── conpty.dll
      ├── win32-arm64/          (same layout)
      ├── linux-x64-glibc/
      │   └── pty.node
      ├── linux-arm64-glibc/
      ├── linux-x64-musl/
      └── ... (whatever the matrix covers)
```

Layout is whatever the tarball for that key contains; resolver doesn't care, it copies wholesale.

### Active location (copied from cache per boot)

```
<repoRoot>/node_modules/node-pty/build/Release/
```

Matches upstream node-pty's first-tried load path. Resolver calls `copyTreeTo(cacheDir, activeDir)` unconditionally each boot — fast (a few MB), idempotent, survives manual pokes. `cpSync` overwrites on conflict, so stale active files from a previous version get replaced on version bump.

---

## 4. Fetch-prebuilts script

`scripts/fetch-prebuilts.mjs` — standalone pure-JS CLI, no TypeScript compilation dependency. Inlines the minimal fetch + extract + copy logic (~50 lines) so the script works on a fresh clone before `npm run build` has ever run. Kept in sync with the resolver's behavior via shared constants (URL base, manifest shape) imported from a tiny shared JS module if duplication becomes a maintenance burden.

```js
#!/usr/bin/env node
// computes depsPath (from argv[2] or default), fetches manifest, downloads tarball,
// verifies checksum, extracts to cache dir, copies into node_modules/node-pty/build/Release/
// exits 0 on success with one-line summary, exits 1 with stderr error on failure
```

`package.json`:

```json
"scripts": {
  "fetch-prebuilts": "node scripts/fetch-prebuilts.mjs"
}
```

README gets one line under a "Development" section explaining the script for air-gapped setups; happy-path users never need it.

CI runs it before `npm test` (see §6).

---

## 5. Workflow change (`.github/workflows/node-pty-prebuilds.yml`)

Current build step cp block:

```bash
cp node_modules/node-pty/build/Release/pty.node "$PACK_DIR/"
if [ "$PLATFORM" = "win32" ]; then
  cp node_modules/node-pty/build/Release/conpty.node "$PACK_DIR/" 2>/dev/null || true
  cp node_modules/node-pty/build/Release/*.dll "$PACK_DIR/" 2>/dev/null || true
  cp node_modules/node-pty/build/Release/*.exe "$PACK_DIR/" 2>/dev/null || true
fi
```

Replace with:

```bash
cp -r node_modules/node-pty/build/Release/. "$PACK_DIR/"
```

Captures `pty.node`, `conpty.node`, `conpty_console_list.node`, `conpty/` subdir, DLLs, EXEs, whatever future versions produce. Windows row on first run reveals actual contents.

Re-run matrix after merge to regenerate v1.1.0 release with complete tarballs. `softprops/action-gh-release@v2` update-in-place behavior overwrites existing release assets.

No other workflow changes needed. Resolver handles the `--strip-components=1` flattening on the extraction side.

---

## 6. Tests

### Keep

- `composePrebuiltKey` tests (2)
- `verifyChecksum` tests (2)
- `libcDetect` tests (existing)
- `getHostInfo` test (if present)

### Remove

- All `homebridgePrebuildPath` tests (helper deleted)
- Old `tryCachedPrebuilt` tests tied to `_findCacheEntry` with the old layout
- Any test that imports `@homebridge/node-pty-prebuilt-multiarch`

### Rewrite

- Top-level `resolveNodePty → {available: true}` happy-path test. Relies on `npm run fetch-prebuilts` having pre-populated the cache (CI does this; devs do it implicitly on first `npm start` or explicitly via the script).

### New — integration test

`src/server/__tests__/nodePtyResolver.integration.test.ts`:

1. Start a local HTTP server on an ephemeral port using `node:http`. Routes:
   - `GET /node-pty-prebuilds-latest/manifest.json` → returns a crafted manifest
   - `GET /node-pty-prebuilds-v{ver}/{key}.tar.gz` → returns a fixture tarball
   - `GET /node-pty-prebuilds-v{ver}/SHA256SUMS` → returns matching checksums
2. Override `RELEASE_URL_BASE` (expose as a parameter or module-level mutable for tests)
3. Create a fixture tarball at test setup by tar-czf'ing the contents of the already-populated cache dir for the test host (`tempDepsPath/node-pty/v{version}/{key}/`). This requires `npm run fetch-prebuilts` to have run in an earlier `beforeAll`, or the test harness primes the cache from `node_modules/node-pty/build/Release/` directly. Fixture is thus a real, valid prebuilt for the test runner's platform — the `require()` step at the end of the resolver chain exercises real native load.
4. Call `resolveNodePty(tempDepsPath)` and assert:
   - Cache dir gets populated with tarball contents
   - Active dir (`node_modules/node-pty/build/Release/`) has the files copied
   - `handle.available === true`
   - Log output contains download + extract messages
5. Teardown: shut down server, remove temp dir, restore active dir from a beforeEach snapshot

Integration test runs in the same `vitest` invocation as unit tests — no separate suite.

### CI

`vitest` setup file (`vitest.config.ts` `globalSetup` hook) calls the same fetch function the CLI uses, once before the whole run. Keeps CI config untouched and makes test setup self-contained — no "remember to run this script first" gotcha for contributors running tests locally.

---

## 7. Cleanup

Files to delete or shrink:
- `src/server/NodePtyResolver.ts` — rewritten (~60% shorter)
- `src/server/__tests__/nodePtyResolver.test.ts` — rewritten (remove homebridge-specific paths)

Files to update:
- `docs/TECHNICAL_GUIDE.md` §18 (Node-Pty Resolver + Publisher) — replace three-source chain narrative with two-source + describe upstream node-pty loader mechanism
- `CHANGELOG.md` [Unreleased] — revise the SP1 entry to describe the final design (drop the homebridge narrative, describe direct node-pty + resolver + publisher)
- `README.md` — if it mentioned homebridge, remove; add one line about `npm run fetch-prebuilts` under a Development section
- `package.json` — swap deps, add `optionalDependencies`, add `fetch-prebuilts` script
- `.npmrc` — create with `ignore-scripts=true`

Memory updates (post-implementation):
- `project_wsscrcpy_sp1_state.md` — retire after successful smoke test
- Add a new `project_wsscrcpy_sp1b.md` documenting the rearchitecture rationale and lessons learned

---

## Risks

- **`.npmrc` ignore-scripts global side effects:** another dep in the future adds a legitimately-needed install script; maintainer runs `npm install`, script silently skipped, something breaks at runtime. Mitigation: comment in `.npmrc` pointing at this spec; CI runs `npm rebuild` explicitly for any future deps that need it.
- **Tarball produced by `cp -r` becomes larger:** from ~200 KB to maybe ~1-2 MB on Windows rows (conpty.dll, OpenConsole.exe, winpty bits). Irrelevant for download speed; note in the spec.
- **Active-location copy on every boot is slow on slow disks:** ~1-2 MB copy takes < 200 ms on SSD; could be hundreds of ms on HDD. Acceptable; if ever a concern, add a "cache version matches active version" short-circuit.
- **Node upgrades mid-session breaking ABI compatibility:** resolver is called once at boot; if user upgrades Node between boot and first shell, spawn would fail because the binary's ABI no longer matches. Negligible in practice; matches SP1 behavior.

## Open questions

None — Q1-Q4 resolved in brainstorm.

## Scope estimate

- Resolver rewrite: ~100 lines (down from ~230)
- Tests: ~150 lines new integration test + ~80 lines trimmed helper tests
- Workflow: 1-line change + re-run matrix
- Fetch script: ~30 lines
- Docs updates: ~50 lines across TECHNICAL_GUIDE, CHANGELOG, README

~3 hours implementation + 30 min matrix re-run + 15 min smoke test + 15 min memory updates.
