# Dev/install layout parity — design

**Date:** 2026-05-14
**Status:** Draft — pending user review
**Author:** brainstormed in-session with Jamie

## Problem statement

Dev mode running `npm run build && node dist/index.js` from the repo diverges from MSI install layout on Windows. The launcher in a real install computes `paths.deps_path = <dataRoot>/dependencies` (`launcher/src/paths.rs:65-68`, where `dataRoot = %PROGRAMDATA%\WsScrcpyWeb`). Dev mode never sets `DEPS_PATH`, so the Node server's `resolveDependenciesPath` falls through to the dev fallback at `Config.ts:67`, which returns `<entryDir>/../dependencies` — i.e. `<repo>/dependencies/`.

`resolveDataRoot` and `resolveConfigPath` already converge dev and install on `C:\ProgramData\WsScrcpyWeb\config.json` and the log path. Only the dependencies path is misaligned. The misalignment caused a recent hour-plus debugging session (2026-05-14) where a prior MSI install's persisted `webPort: 8001` in `<dataRoot>\config.json` carried over into a dev run, and the user couldn't tell the dev process was hitting a different port than the browser. Aligning the dependencies path closes the divergence loop without changing iteration speed.

## Scope

In scope:
- `src/server/Config.ts::resolveDependenciesPath` — change the Windows dev fallback to `<dataRoot>/dependencies/`.
- `src/server/__tests__/config.depsPath.test.ts` — update test 4 and error-message tests; add Windows-specific cases.
- `scripts/stage-seed-scrcpy-server.mjs` — new `prestart` step that mirrors `scripts/stage-publish.mjs:194-203` so dev's `<repo>/seed/scrcpy-server/scrcpy-server` matches what CI ships in install.
- `package.json` — wire the new prestart script into the existing prestart chain (it already runs `stage-seed-node-pty.mjs`).
- Repo cleanup: delete orphan `<repo>/config.json`; add a comment/README in `<repo>/dependencies/` declaring it Linux-dev-only.
- `todo_ws_scrcpy_web.md` — log a v0.5.0 follow-up to design the Linux Phase-1-equivalent `dataRoot`.

Out of scope (explicitly):
- Pre-populating `<dataRoot>/dependencies/adb/` or `<dataRoot>/dependencies/node/` on dev. `autoInstallMissing` handles this in install; matching install means dev does the same — including the one-time ~30-60 s first-launch download.
- Installing dev binaries to `C:\Program Files\WsScrcpyWeb\`. User decided dev runs from `<repo>\dist\` indefinitely.
- Linux Phase-1-equivalent `dataRoot` (deferred to v0.5.0 backlog).

## Architecture

### Section 1 — resolver change (the load-bearing edit)

Current `resolveDependenciesPath` priority chain (`Config.ts:58-76`):

1. `env.DEPS_PATH`
2. `fileConfig.dependenciesPath`
3. Dev fallback: `path.resolve(path.dirname(entryScript), '..', 'dependencies')`, gated on a `package.json` "dev tell" sibling.
4. Throw — neither configured nor in a dev checkout.

New chain (Windows only):

1. `env.DEPS_PATH` *(unchanged)*
2. `fileConfig.dependenciesPath` *(unchanged)*
3. **`path.win32.join(resolveDataRoot(env), 'dependencies')` — no dev-tell gate, no existence check.** This mirrors `launcher/src/paths.rs:65-68` byte-for-byte in semantics.

On non-Windows, the chain is unchanged — `paths.rs:62` collapses `data_root` to `install_root` on Linux, so no migration target exists there yet. A v0.5.0 backlog item tracks designing the Linux equivalent (see Out of scope).

Signature:

```ts
export function resolveDependenciesPath(
    env: NodeJS.ProcessEnv,
    fileConfig: FlatConfig,
    entryScript: string,
    exists: (p: string) => boolean = fs.existsSync,
    platform: NodeJS.Platform = process.platform,
): string
```

The `platform` parameter is purely for testability — matches the style of `resolveDataRoot` and `resolveAdbPath`. Default is `process.platform`; tests inject explicit values.

Implementation sketch:

```ts
if (env['DEPS_PATH']) return env['DEPS_PATH'];
if (fileConfig.dependenciesPath) return fileConfig.dependenciesPath;

if (platform === 'win32') {
    const dataRoot = resolveDataRoot(env, platform);
    if (dataRoot) return path.win32.join(dataRoot, 'dependencies');
    // dataRoot is non-null on Windows by contract — fall through is dead, but keep the throw below as a defensive guard.
}

const entryDir = path.dirname(entryScript);
const devCandidate = path.resolve(entryDir, '..', 'dependencies');
const devTell = path.resolve(entryDir, '..', 'package.json');
if (exists(devTell)) return devCandidate;

throw new Error(
    'DEPS_PATH is not set and no dependencies path is configured. ' +
    'On Windows, dependencies are expected at <dataRoot>/dependencies (default %PROGRAMDATA%\\WsScrcpyWeb\\dependencies). ' +
    'On Linux, set DEPS_PATH or place a `dependencies/` folder next to a `package.json` sibling of the entry script.',
);
```

### Section 2 — scrcpy-server seed staging in dev

`DependencyManager.promoteSeedScrcpyServer` (`DependencyManager.ts:224-237`) looks at `__dirname/../seed/scrcpy-server/scrcpy-server`. In install, `__dirname = <installRoot>/current/dist/`, so it looks at `<installRoot>/current/seed/scrcpy-server/scrcpy-server` — populated by `scripts/stage-publish.mjs:194-203`. In dev, `__dirname = <repo>/dist/`, so it looks at `<repo>/seed/scrcpy-server/scrcpy-server` — which does not exist.

Today this isn't catastrophic (autoInstallMissing fetches scrcpy-server from GitHub on first run, ~90 KB), but it means dev does NOT exercise the seed-promotion code path. User decision: stage the seed so dev mirrors install exactly. No drift.

New script: `scripts/stage-seed-scrcpy-server.mjs`. Behavior:

1. Source: `<repo>/assets/scrcpy-server` (the vendored JAR, pinned to `Constants.SERVER_VERSION`). This is the same source `stage-publish.mjs` uses.
2. Destination: `<repo>/seed/scrcpy-server/scrcpy-server`.
3. Idempotent: skip copy if destination is byte-identical to source. Re-copy otherwise.
4. **Drift sanity check:** before copying, verify the source file's existence; log a clear error if `assets/scrcpy-server` is missing or zero-length. Optionally hash-check against a pinned digest in a constants file if we ever ship one.
5. Wire into `package.json` `prestart` alongside `stage-seed-node-pty.mjs`.

This still doesn't write into `<dataRoot>/dependencies/` — the seed lives in the repo's `seed/` directory, exactly where install's seed lives in `<installRoot>/current/seed/`. `promoteSeedScrcpyServer` runs at server startup and copies it from there to `<dataRoot>/dependencies/scrcpy-server/scrcpy-server` (matching install's runtime behavior).

### Section 3 — repo cleanup

| Path | Action | Why |
|------|--------|-----|
| `<repo>/config.json` | **Delete** | Orphan since Phase 1. Never read on Windows. Confuses future readers. |
| `<repo>/dependencies/` | **Keep**, add `README.md` noting it's Linux-dev-only | Still the Linux dev fallback. On Windows, the new resolver bypasses it entirely. |
| `<repo>/dependencies/adb/.gitkeep`, `<repo>/dependencies/node/.gitkeep`, etc. | Keep | Pin the dir scaffold for the Linux fallback. |
| `<repo>/seed/scrcpy-server/` | Create as part of the new prestart staging | Mirrors install seed layout. |
| `.gitignore` (if needed) | Add `seed/scrcpy-server/scrcpy-server` if not already covered by a generic `seed/*` pattern | Staged artifact, sourced from `assets/`. |

A new TODO in `todo_ws_scrcpy_web.md`:

> ### §X. v0.5.0 — design Linux Phase-1-equivalent dataRoot (Group A — DEFERRED)
> Linux installs today collapse `data_root` onto `install_root` (`launcher/src/paths.rs:62`). The Windows dev fallback now diverges from Linux dev because Linux has no `%PROGRAMDATA%` equivalent. Pick a target — `~/.local/share/WsScrcpyWeb/` (XDG), `/var/lib/wsscrcpy-web/` (system-wide), or stay collapsed — and propagate through `paths.rs::compute`, `resolveDataRoot`, and `resolveDependenciesPath`. Until decided, Linux dev continues to use `<repo>/dependencies/`.

## Data flow

Dev launch from `<repo>` after the change, first time (empty `<dataRoot>`):

```
1. `npm run build && npm start`         (or `node dist/index.js` directly)
   - prestart runs scripts/stage-seed-node-pty.mjs  (existing)
   - prestart runs scripts/stage-seed-scrcpy-server.mjs  (new)
2. Server entry: Config.getInstance()
   2a. dataRoot = resolveDataRoot(env) = C:\ProgramData\WsScrcpyWeb
   2b. configFilePath = <dataRoot>\config.json — file missing, defaults applied silently
   2c. dependenciesPath = resolveDependenciesPath(env, fileConfig, entry, fs.existsSync, 'win32')
       → new branch: <dataRoot>\dependencies
   2d. adbPath = resolveAdbPath(fileConfig, dependenciesPath) = <dataRoot>\dependencies\adb\adb.exe
3. DependencyManager constructor — state initialized empty
4. checkAll() → checkInstalled for each dep
   - node: <dataRoot>\dependencies\node\node.exe missing → null
   - adb:  <dataRoot>\dependencies\adb\adb.exe missing → null
   - scrcpy-server: missing → null
5. autoInstallMissing()
   - promoteSeedScrcpyServer copies <repo>\seed\scrcpy-server\scrcpy-server →
     <dataRoot>\dependencies\scrcpy-server\scrcpy-server
   - downloads adb + node from official mirrors to <dataRoot>\dependencies\
6. Second checkAll round (next 15s poll OR explicit "check for updates")
   - all three return non-null versions; status → UpToDate
7. UI banner clears; dependency table renders correctly
```

Steady-state (subsequent launches): step 4 finds binaries, step 5 is a no-op for everything, panel renders correctly immediately.

This is identical to the first-launch path on a clean Windows 11 VM after MSI install. The recent debugging session would not have happened under this flow because:
- The orphan `<repo>/config.json` doesn't exist to mislead.
- Dev and install share the same `webPort` persisted at `<dataRoot>/config.json`, so any auto-shift sticks consistently for both.
- The dep panel reads from the same `<dataRoot>/dependencies/` that the launcher's Node child reads from — no two-instance-different-deps-folder confusion possible.

## Error handling

`resolveDataRoot` defaults `PROGRAMDATA` to `C:\ProgramData` when the env var is missing (`Config.ts:128-131`), so the new fallback is well-defined even on stripped Windows installs. Only failure mode that returns a different path is when `process.platform !== 'win32'`, which falls through to the existing dev-tell-gated path.

The new error message (when nothing resolves) explicitly names the platform-appropriate fallback location. Quoted in the implementation sketch above.

`scripts/stage-seed-scrcpy-server.mjs` fails loud if `<repo>/assets/scrcpy-server` is missing or zero-length — that's a repo-integrity problem, not a per-launch hiccup, and the prestart step should refuse to continue rather than silently leaving the seed dir empty.

## Testing

`src/server/__tests__/config.depsPath.test.ts` changes:

| Test # | Before | After |
|--------|--------|-------|
| 1 | "returns DEPS_PATH env when set" | unchanged |
| 2 | "env wins over fileConfig and dev fallback" | unchanged |
| 3 | "returns fileConfig.dependenciesPath when env is absent" | unchanged |
| 4 | "falls back to ../dependencies when package.json sibling exists (dev)" | split into 4a (Linux/Darwin: `<entryDir>/../dependencies/` with dev tell) and 4b (Windows: `<dataRoot>/dependencies/` regardless of dev tell, asserting use of injected PROGRAMDATA) |
| 5 | "throws a clear error when no source resolves and dev tell is missing" | reworded — non-Windows case only (Windows never reaches the throw under the new chain) |
| 6 | "error message names DEPS_PATH and config.json" | error message now also names `<dataRoot>/dependencies` for Windows; rewrite assertions |

New tests:

- "On Windows, with no env and no fileConfig.dependenciesPath, returns `<PROGRAMDATA>\\WsScrcpyWeb\\dependencies` even when a dev-tell package.json sibling exists" — proves Windows skips the dev fallback entirely.
- "On Windows, with no env and no fileConfig, defaults PROGRAMDATA to `C:\\ProgramData` when env var absent" — matches `resolveDataRoot`'s defaulting behavior.

`scripts/stage-seed-scrcpy-server.mjs`: no unit tests planned (it's a 30-line script that's effectively tested by its consumer — `promoteSeedScrcpyServer`'s existing tests cover the staged-artifact-found-and-copied path). Add an integration check to the prestart smoke flow: after prestart, `<repo>/seed/scrcpy-server/scrcpy-server` exists and is byte-identical to `<repo>/assets/scrcpy-server`.

Full test count expectation: vitest run grows by 2-3 tests, all passing.

## Implementation order (when we get to it)

1. Branch off `main`: `feat/dev-install-layout-parity`.
2. Update `Config.ts::resolveDependenciesPath` signature + Windows branch.
3. Update `config.depsPath.test.ts`. Run vitest — must pass.
4. Write `scripts/stage-seed-scrcpy-server.mjs`. Wire into `package.json` prestart.
5. Manually exercise: delete `<dataRoot>` entirely, run `npm start`, verify clean first-launch flow including scrcpy-server seed promotion + adb/node download.
6. Delete `<repo>/config.json`. Add `<repo>/dependencies/README.md` with the Linux-dev-only note.
7. Update `docs/TECHNICAL_GUIDE.md` if there's a Packaging/Paths chapter that references the dev fallback (likely is).
8. Add the v0.5.0 Linux dataRoot TODO entry to `todo_ws_scrcpy_web.md`.
9. CHANGELOG.md entry under `[Unreleased]`.
10. Tag-less merge to `main` once smoke passes (solo-owned repo, no PR per `feedback_pr_workflow.md`).

Rollback plan: revert the resolver commit. Dev mode immediately reverts to repo-side `<repo>/dependencies/`. No state-format change, no migration needed.

## Open questions left for implementation

None that block writing the plan. Two minor items to confirm during implementation:

- Whether `package.json`'s prestart chain currently exits early on first failure. If not, sequence the new script after `stage-seed-node-pty.mjs` so a node-pty failure surfaces first (more diagnostic value).
- Whether the `seed/scrcpy-server/` directory should be `.gitignore`'d (staged artifact) or committed (vendored, parallel to `assets/scrcpy-server`). Default: gitignore to match `seed/node-pty-pkg/` precedent.
