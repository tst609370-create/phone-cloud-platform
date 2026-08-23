# SP1: node-pty Prebuilt Matrix — Design Spec

**Date:** 2026-04-21
**Roadmap:** `docs/superpowers/specs/2026-04-21-installer-docker-roadmap.md`
**Status:** Design approved, pending implementation plan

---

## Goal

End the current situation where installing ws-scrcpy-web triggers a `node-gyp` compile of node-pty. Replace it with a resilient two-source prebuilt-binary system that works out-of-the-box on every platform we target, with zero user-visible C++ toolchain requirement.

## Non-goals

- Building for platforms outside our 6-row matrix (ia32, FreeBSD, etc.)
- Supporting users who run the app against system Node installs not managed by the dep-manager (they can still do so, but prebuilt coverage matches what we ship)
- Replacing `microsoft/node-pty` as the upstream source — we stay on upstream for API surface; we only change the build/distribution layer

## Architecture overview

Two independent prebuilt sources compose into a single fallback chain evaluated at app startup:

```
┌─ primary ─────────────────────────────────────────┐
│  @homebridge/node-pty-prebuilt-multiarch (npm)    │
│    - Installed as a direct dependency             │
│    - Native `require()` resolves to their prebuilt│
│      if one matches current Node ABI              │
└───────────────────────────────────────────────────┘
                      │
         fails to load (no matching ABI)
                      ▼
┌─ fallback ────────────────────────────────────────┐
│  Our own prebuilts, published to GH Releases      │
│    - Downloaded on-demand by NodePtyResolver      │
│    - Cached in depsPath/node-pty/prebuilds/       │
│    - Loaded via process.env.NODE_PTY_BINARY_PATH  │
│      or equivalent resolver hook                  │
└───────────────────────────────────────────────────┘
                      │
              both fail to load
                      ▼
┌─ graceful degradation ────────────────────────────┐
│  nodePtyAvailable = false                         │
│  Shell modal disabled with tooltip                │
│  Rest of app fully functional                     │
└───────────────────────────────────────────────────┘
```

The homebridge fork is the primary because it's already maintained and widely deployed via the Homebridge ecosystem. Our own prebuilt pipeline is the safety net that activates automatically when the homebridge fork is stale for a new Node LTS.

## Components

### C1. npm dependency swap

`package.json`:
- Remove: `"node-pty": "^1.1.0"`
- Add: `"@homebridge/node-pty-prebuilt-multiarch": "^0.11.x"` (pin current latest at implementation time)

All existing `import * as pty from 'node-pty'` sites either continue to work via the fork's identical API surface, or are updated to import from the new package name. Implementation plan resolves this; API surface is identical per homebridge's stated goal.

### C2. Consumer resolver (`src/server/NodePtyResolver.ts`, new file, ~80 lines)

Runs exactly once at server startup, before any code imports node-pty. Its job is to produce a single usable `require()` handle for node-pty (or a boolean flag indicating unavailability).

**Interface:**
```typescript
export interface NodePtyHandle {
    available: boolean;
    pty?: typeof import('node-pty'); // only present when available === true
    reason?: string; // on unavailable: human-readable explanation for UI
}

export async function resolveNodePty(depsPath: string): Promise<NodePtyHandle>;
```

**Resolution chain:**

1. **Try homebridge first.** `require('@homebridge/node-pty-prebuilt-multiarch')`. If the native module loads, return `{ available: true, pty }`. Done.
2. **Catch the native-load failure.** node-pty throws at first require() on a platform/arch/ABI mismatch. Catch, log at debug level, continue.
3. **Detect the host.** Compose the expected prebuilt key: `{platform}-{arch}-{libc}-v{nodeABI}` where:
   - `platform`: `process.platform` — `"win32"` or `"linux"`
   - `arch`: `process.arch` — `"x64"` or `"arm64"`
   - `libc`: `"glibc"` or `"musl"` (see §C3)
   - `nodeABI`: `process.versions.modules` — e.g. `"127"` for Node 24
4. **Check the on-disk cache.** `{depsPath}/node-pty/prebuilds/{key}/pty.node` — if present and valid (SHA256 matches `{key}.sha256` sibling file), copy the file path into `process.env.NODE_PTY_BINARY_PATH`, try `require('@homebridge/node-pty-prebuilt-multiarch')` again. It will use the env pointer.
5. **Download if cache missed.** Fetch the tarball from our GH Releases (§C5). Verify checksum against `SHA256SUMS` on the same release. Extract to the cache location. Retry the require.
6. **Total failure.** If no prebuilt exists anywhere for this key, return `{ available: false, reason: "no-prebuilt-for-abi-{nodeABI}-{platform}-{arch}-{libc}" }`. The server continues starting.

**Retry/timeout policy:**
- Download: single attempt with 30s timeout. No retry loop — next app start will retry.
- Cache validation: SHA256 mismatch deletes the file and falls through to download path.
- Checksum fetch: fail-closed; missing or unreachable `SHA256SUMS` → refuse to use downloaded tarball.

### C3. libc detection

```typescript
function detectLibc(): 'glibc' | 'musl' {
    if (process.platform !== 'linux') return 'glibc'; // irrelevant on Windows
    // Primary: glibcVersionRuntime is present on glibc, absent on musl
    const report = (process.report as any)?.getReport?.();
    if (report?.header?.glibcVersionRuntime) return 'glibc';
    // Fallback: Alpine writes /etc/alpine-release
    try {
        require('fs').accessSync('/etc/alpine-release');
        return 'musl';
    } catch { /* not Alpine */ }
    // Fallback 2: probe ldd --version stderr for "musl"
    try {
        const { execFileSync } = require('child_process');
        const out = execFileSync('ldd', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
        if (out.toLowerCase().includes('musl')) return 'musl';
    } catch { /* ldd not present or errored */ }
    return 'glibc';
}
```

Three layers of detection because no single probe covers every case (containers without `/etc/alpine-release`, minimal images without `ldd`, etc.).

### C4. Graceful degradation surface

New HTTP endpoint: `GET /api/capabilities` returns `{ shell: boolean }` based on the resolver's outcome. Implemented in `src/server/api/CapabilitiesApi.ts`.

Frontend wiring:
- `DeviceTracker` fetches `/api/capabilities` once on mount alongside the existing device-list fetch.
- `buildDeviceRow` in `BaseDeviceTracker.ts` reads the cached capabilities. If `shell === false`, the `shell` button on each device card gets `disabled` + a `title` tooltip: `"Shell unavailable — no node-pty prebuilt matches your Node version. Update Node in the Dependencies panel or wait for the next prebuild release."`
- Every other feature (stream, config stream, list files, connect, disconnect, sleep/wake) is unaffected.

### C5. Build pipeline (GitHub Actions)

**Location:** `.github/workflows/node-pty-prebuilds.yml` in the main `ws-scrcpy-web` repo (not a separate repo — simpler governance and CI surface). The workflow is self-contained; it doesn't touch the app's build.

**Triggers:**

```yaml
on:
  schedule:
    - cron: '0 9 * * 1'      # weekly Monday 9am UTC — checks for new Node LTS or new node-pty release
  workflow_dispatch:          # manual
```

**Pre-check job** (single job, runs before the matrix):

```
1. Fetch https://nodejs.org/dist/index.json
2. Identify current LTS and prior LTS (two newest `lts: <codename>` entries)
3. Fetch https://api.github.com/repos/microsoft/node-pty/releases/latest
4. Compare these four values against .github/state/node-pty-prebuilds-state.json (stored in the repo)
5. If no changes: exit 0 with "nothing to build"
6. If changes: write the new state file, commit via github-actions[bot], and emit outputs that feed the matrix job
```

State file format:
```json
{
  "nodePtyVersion": "1.1.0",
  "nodeCurrentLts": { "version": "24.12.0", "abi": "127" },
  "nodePriorLts": { "version": "22.18.0", "abi": "115" },
  "lastBuiltAt": "2026-04-21T09:00:00Z"
}
```

**Matrix job** (12 rows):

```yaml
strategy:
  fail-fast: false
  matrix:
    include:
      # Windows
      - { os: windows-latest, arch: x64, libc: '',   abi: current, runner: native }
      - { os: windows-latest, arch: x64, libc: '',   abi: prior,   runner: native }
      - { os: windows-11-arm, arch: arm64, libc: '', abi: current, runner: native }
      - { os: windows-11-arm, arch: arm64, libc: '', abi: prior,   runner: native }
      # Linux glibc
      - { os: ubuntu-latest,     arch: x64,   libc: glibc, abi: current, runner: native }
      - { os: ubuntu-latest,     arch: x64,   libc: glibc, abi: prior,   runner: native }
      - { os: ubuntu-24.04-arm,  arch: arm64, libc: glibc, abi: current, runner: native }
      - { os: ubuntu-24.04-arm,  arch: arm64, libc: glibc, abi: prior,   runner: native }
      # Linux musl (Alpine container)
      - { os: ubuntu-latest,     arch: x64,   libc: musl,  abi: current, runner: alpine }
      - { os: ubuntu-latest,     arch: x64,   libc: musl,  abi: prior,   runner: alpine }
      - { os: ubuntu-24.04-arm,  arch: arm64, libc: musl,  abi: current, runner: alpine }
      - { os: ubuntu-24.04-arm,  arch: arm64, libc: musl,  abi: prior,   runner: alpine }
```

Per-row steps:
1. Checkout repo (to read the state file and script paths)
2. `actions/setup-node@v4` with `node-version` driven by the matrix row and upstream state
3. For alpine rows: `container: node:${abi}-alpine` on the job, which gives us a musl Node out of the box
4. `npm init -y` in a scratch dir, then `npm install --no-save microsoft/node-pty@${upstreamVersion}` — this triggers `node-gyp rebuild` against the target Node
5. Copy `node_modules/node-pty/build/Release/pty.node` (and on Windows, `conpty.node` + `conpty.dll` + `winpty.dll` + `winpty-agent.exe`) into a packaging dir
6. Tar + gzip: `node-pty-v{upstreamVersion}-node-abi{abi}-{platform}-{arch}-{libc}.tar.gz`
7. Compute SHA256, write alongside
8. Upload as build artifact

**Aggregate + publish job:**

1. Download all 12 matrix artifacts
2. Concatenate SHA256 files into a single `SHA256SUMS`
3. Create/update a GH Release tagged `node-pty-prebuilds-v{upstreamVersion}` with all 12 tarballs + `SHA256SUMS` attached
4. On any matrix-row failure: open a GH issue tagged `prebuild-failure`, titled e.g. `Prebuild failure: linux-arm64-musl-abi127 — 2026-04-21`, with a link to the failing workflow run

**Alerts:**
- Failed matrix row → auto-opened GH issue → standard GH watch notification emails fire to repo watchers.
- No extra webhook/email infra needed; "watch" settings on the repo handle it.

### C6. Release artifact layout

Each GH Release tagged `node-pty-prebuilds-v{upstreamVersion}` contains:

```
node-pty-v1.1.0-node-abi127-win32-x64.tar.gz
node-pty-v1.1.0-node-abi127-win32-arm64.tar.gz
node-pty-v1.1.0-node-abi127-linux-x64-glibc.tar.gz
node-pty-v1.1.0-node-abi127-linux-arm64-glibc.tar.gz
node-pty-v1.1.0-node-abi127-linux-x64-musl.tar.gz
node-pty-v1.1.0-node-abi127-linux-arm64-musl.tar.gz
node-pty-v1.1.0-node-abi115-win32-x64.tar.gz
... (12 total)
SHA256SUMS
```

The consumer resolver constructs the URL as:
```
https://github.com/bilbospocketses/ws-scrcpy-web/releases/download/node-pty-prebuilds-v{upstreamVersion}/node-pty-v{upstreamVersion}-node-abi{nodeABI}-{platform}-{arch}{-libc for linux}.tar.gz
```

Release body (auto-generated, ~10 lines) lists the matrix that was built, the Node ABIs covered, and the upstream node-pty commit.

## Testing strategy

### Unit tests (`src/server/__tests__/nodePtyResolver.test.ts`)

- `detectLibc()` returns `'glibc'` / `'musl'` / `'glibc'` under mocked conditions (mock `process.report`, `fs.accessSync`, `execFileSync`).
- Cache-key composition produces the correct filename for each platform/arch/libc/abi combination.
- Resolution chain exits at the first successful layer (integration test with a fake prebuilt on disk).
- SHA256 mismatch in cache path deletes + re-downloads.
- Download timeout returns `{ available: false }` without hanging.

### Integration test (CI)

Running the test suite in a matrix (mirroring the prebuilt matrix) catches platform-specific resolver bugs. This is a nice-to-have; plan targets a single-platform test run initially (host where CI executes).

### Manual QA post-deploy

- Ubuntu x64 + bundled Node: shell modal opens, commands execute.
- Windows 11 x64 + bundled Node: shell modal opens, commands execute.
- Alpine x64 Docker container with `dependencies/` mounted: shell modal opens, commands execute. Verifies musl path.
- Linux arm64 (tester's Pi or emulator): shell modal opens. Deferred if no arm64 hardware available at SP1 release time — can validate during SP4 Docker work.

### Failure-mode QA

- Simulate no-prebuilt-available by temporarily deleting the cache + blocking the GH Releases URL in hosts file. Confirm: app starts, shell button is disabled with the tooltip, other features work, dep manager still functions.

## Operational — what touches a human and when

| Event | Who does what |
|---|---|
| Weekly cron runs, nothing new | Fully silent. No issue, no notification. |
| Weekly cron sees new Node LTS or new node-pty release | Pre-check job commits state update, matrix runs, publishes release. Repo watchers get a "new release" email from GH; no action required. |
| One matrix row fails | Auto-opened issue; email to watchers. We investigate (usually: GH bumped a runner image or upstream changed a build quirk). Fix is typically a 1-line YAML edit. |
| All 12 rows fail | Auto-opened issue; more urgent. Likely a structural change in node-pty or node-gyp that needs investigation. |
| User on brand-new Node major with no prebuilt (race: ABI changed but cron hasn't fired yet) | User's shell modal is disabled until next cron run (up to 7 days). Their app still works. Next successful run publishes the prebuilt; user's next app launch picks it up. |
| Homebridge stops shipping | Our fallback path activates silently per-user. No action required. |

## Files to create / modify

### Create
- `.github/workflows/node-pty-prebuilds.yml` — the matrix pipeline
- `.github/state/node-pty-prebuilds-state.json` — tracked build state
- `src/server/NodePtyResolver.ts` — consumer resolver
- `src/server/api/CapabilitiesApi.ts` — `GET /api/capabilities`
- `src/server/__tests__/nodePtyResolver.test.ts` — unit tests
- `scripts/compute-matrix-versions.mjs` — small Node script used by the pre-check job to compare state

### Modify
- `package.json` — swap node-pty → @homebridge/node-pty-prebuilt-multiarch
- `src/server/index.ts` — call `resolveNodePty()` at startup, wire result into capability endpoint
- Any file that does `import * as pty from 'node-pty'` — no behavior change, possibly no code change depending on how homebridge exports
- `src/app/googDevice/client/DeviceTracker.ts` — read `/api/capabilities`, gate the shell button
- `docs/TECHNICAL_GUIDE.md` — add a §N subsection documenting the resolver + prebuilt story

## Explicit non-decisions deferred to implementation plan

- Exact version pin for `@homebridge/node-pty-prebuilt-multiarch` (latest at plan-write time)
- Exact GH release tag naming convention (proposed above; may need tweak if it collides with existing tags)
- Test matrix runner names if GH changes labels between now and implementation (`ubuntu-24.04-arm` is current as of April 2026; may evolve)
- Whether to run the full resolver during dev mode (`npm run start` with a dev checkout) or short-circuit to `require('node-pty')` directly — implementation plan decides

## References

- [homebridge/node-pty-prebuilt-multiarch](https://github.com/homebridge/node-pty-prebuilt-multiarch)
- [microsoft/node-pty](https://github.com/microsoft/node-pty)
- [Node.js release schedule](https://github.com/nodejs/Release)
- [GitHub-hosted ARM runners announcement](https://github.blog/2024-09-03-arm64-on-github-actions-powering-faster-more-efficient-build-systems/)
- Installer + Docker roadmap: `docs/superpowers/specs/2026-04-21-installer-docker-roadmap.md`
