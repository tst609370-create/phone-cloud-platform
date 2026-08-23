# SP2 — Dep-manager polish (design)

**Date:** 2026-04-21
**Status:** Approved, pending tactical plan
**Predecessor:** `docs/superpowers/specs/2026-04-21-installer-docker-roadmap.md`
**Successor:** `docs/superpowers/plans/2026-04-21-sp2-dep-manager-polish.md` (to be written by the writing-plans step)

---

## Purpose

SP2 is the last piece of foundation work before SP3 (Velopack installer) and SP4 (Docker image) can land cleanly. It tightens the existing `DependencyManager` / `Config` / launcher-script surface so the same server binary runs correctly in four deployment shapes: dev checkout, Velopack host install (Windows), Velopack host install (Linux), and Docker container. It also integrates the Option D Node-update gate against the node-pty prebuilt matrix delivered by SP1/SP1b.

Originally SP2 was scoped with a fourth deliverable — first-run bootstrap of Node/ADB/scrcpy-server — but that was split into **SP2b** during this brainstorm because it is a larger UX + network + chicken-and-egg subsystem on its own.

---

## 1. Scope

### In scope

1. **`depsPath` resolution** that works correctly across all four target scenarios without heuristic guesswork.
2. **Restart-signal primitive upgrade:** `.restart` marker file **plus** process exit code `75` (belt + suspenders).
3. **Option D Node policy:** `DependencyDefinitions.nodejs.checkLatest()` filters candidate Node LTS releases by whether a matching node-pty prebuilt exists in our GH Releases manifest (same manifest SP1b's `NodePtyResolver` already loads). Never auto-downgrade. Silently skip majors without a prebuilt. No force-update escape hatch.
4. **`Logger.for('DependencyManager')` coverage** at Medium granularity (operation shape + aggregates, not per-item details — matching the existing `feedback_logging_granularity` convention).

### Out of scope (deferred)

- **SP2b — First-run bootstrap**: downloading Node/ADB/scrcpy when the `dependencies/` folder is empty, with a progress UI, offline-fallback UX, and a bootstrap-Node strategy. Its own spec.
- **SP3 — Velopack installer**: `vpk.config`, release CI, package formats. Consumes SP2's primitives.
- **SP4 — Docker image**: multi-stage `Dockerfile`, `docker-compose.yml`, `start.sh` as ENTRYPOINT, named volume for `dependencies/`. Consumes SP2's primitives.
- **`DependencyPanel` client UI changes**: no UI work in SP2. The "Node 26 available (prebuilt pending)" muted state is explicitly rejected per Option D edge rule 2 (silent skip).
- **Changes to how scrcpy-server or ADB version discovery works.** Option D applies only to Node because it is the only dependency whose update can ABI-break another managed binary (node-pty). ADB and scrcpy-server have no ABI coupling to our shipped code.

---

## 2. Layout and `depsPath` resolution

### Canonical layout per scenario

| Scenario | `current/` (binaries, wiped on update) | `dependencies/` (survives updates) |
|---|---|---|
| Dev checkout | `<repo>/` (no `current/`; `dist/` is direct) | `<repo>/dependencies/` |
| Velopack Windows | `%LocalAppData%\WsScrcpyWeb\current\` | `%LocalAppData%\WsScrcpyWeb\dependencies\` |
| Velopack Linux | `/opt/WsScrcpyWeb/current/` | `/opt/WsScrcpyWeb/dependencies/` |
| Docker | `/app/` | `/app/dependencies/` (Docker named volume) |

The sibling-of-`current/` pattern is the Velopack-documented idiom for data that must persist across app updates ([Velopack docs: Preserving Files & Settings](https://github.com/velopack/velopack.docs/blob/master/docs/integrating/preserved-files.mdx)). It is inside the app's `installFolder` — not outside — so from an operator's standpoint the app is still one self-contained tree.

### Resolution logic

Current code in `src/server/Config.ts:99`:
```ts
const dependenciesPath = process.env['DEPS_PATH']
    ?? fileConfig.dependenciesPath
    ?? path.resolve(path.dirname(process.argv[1] || '.'), '..', 'dependencies');
```

The relative-to-`process.argv[1]` fallback is correct for dev (`dist/index.js` → `../dependencies`) but wrong for Velopack, where the entry script lives at `<installFolder>/current/dist/index.js` and the correct deps path is `<installFolder>/dependencies/` — two levels up, not one.

New resolution logic:

```
dependenciesPath =
    process.env.DEPS_PATH                  // highest priority, explicit
    ?? fileConfig.dependenciesPath         // config.json override
    ?? devFallback()                       // ONLY when dev layout is detected
    ?? throw ClearStartupError             // no implicit production behavior
```

**`devFallback()`** returns `path.resolve(path.dirname(process.argv[1]), '..', 'dependencies')` **only when** `path.resolve(path.dirname(process.argv[1]), '..', 'package.json')` exists. That `package.json`-sibling check is the unambiguous "we are in a dev checkout" tell. Production bundles do not ship a top-level `package.json` next to `dist/`.

**Hard-fail error message** on missing `DEPS_PATH` in non-dev scenarios:

> `DEPS_PATH is not set and no dependencies path is configured. Set the DEPS_PATH environment variable (the launcher script does this automatically) or add "dependenciesPath" to config.json. Expected location example: <installFolder>/dependencies/`

### Launcher script behavior

`start.cmd` and `start.sh` already export `DEPS_PATH` (see `start.cmd:11` and `start.sh:9`). No change to that export. The marker-path change (next section) DOES require editing both scripts.

---

## 3. Restart-signal primitive

### What changes

Today: `DependencyManager.requestRestart()` writes `.restart` at `path.dirname(depsPath)` and exits with code `0`.

Two problems:
1. **Marker location is wrong for Velopack.** `path.dirname(depsPath)` in dev equals `<repo>` (correct — same directory as the launcher). In Velopack, `path.dirname(depsPath)` equals `<installFolder>`, but the launcher lives at `<installFolder>/current/start.cmd` — so the launcher would never see the marker at `<installFolder>/.restart`.
2. **Exit code `0` is indistinguishable from a normal clean shutdown.** systemd, Docker restart policies, and Windows service wrappers cannot discriminate "restart me, I'm applying an update" from "stop, the user asked me to exit."

New behavior:
- Marker path: `path.join(depsPath, '.restart')` — a single location both the server and launcher derive from `DEPS_PATH`.
- Exit code: `75` (conventional `EX_TEMPFAIL` — "temporary failure; caller should retry", a reasonable analogue of "I want to restart").
- Both are emitted on every restart request. Consumers (launcher, supervisor) can consume either.

### Data flow

```
UI "Update Node" click
  → DependencyManager.update('nodejs')
  → install completes
  → UpdateResult { success: true, requiresRestart: true }
  → client shows "restart pending" state (existing UX)
  → user clicks "Restart now" (or existing auto-timeout)
  → DependencyManager.requestRestart()
      • writes marker at `<depsPath>/.restart`
      • calls process.exit(75)
  → launcher (dev / Velopack stub) OR supervisor (systemd / Docker / nssm)
    restarts the process
  → new process boots with the updated Node
```

### Launcher script changes

`start.cmd`:
- Replace `set "RESTART_MARKER=%SCRIPT_DIR%.restart"` with `set "RESTART_MARKER=%DEPS_PATH%\.restart"`.
- The cleanup-on-entry `if exist "%RESTART_MARKER%" del "%RESTART_MARKER%"` still applies.
- The post-exit loop condition becomes: `if exist "%RESTART_MARKER%"` **OR** `%EXIT_CODE%` is `75`. Either triggers the goto-loop branch.

`start.sh`: mirror of the above using `$DEPS_PATH/.restart` and `$EXIT_CODE -eq 75`.

### Supervisor integration (SP3/SP4 problem, but documented here)

- **systemd (Linux installer):** `Restart=on-failure`, `RestartForceExitStatus=75` in the unit file. The supervisor interprets 75 as "restart on purpose"; any other non-zero is a crash that still gets retried by `on-failure`.
- **Docker (SP4):** `restart: on-failure` in `compose.yml`. Docker does not discriminate exit codes but will restart regardless of which signal path the server took. If `start.sh` is the container `ENTRYPOINT`, the restart happens inside the container and Docker never sees the exit at all — also fine.
- **Windows service (optional, post-SP3):** nssm or `sc.exe` configuration sets "restart on exit code 75".

---

## 4. Option D — Node policy gated by node-pty prebuilts

### Rule

`DependencyDefinitions.nodejs.checkLatest()` returns the newest Node LTS version for which the node-pty prebuilt manifest (published by SP1b at GH Releases, cached locally by `NodePtyResolver.loadManifest()`) contains an entry matching the current `{platform, arch}`.

### Pseudocode

```
nodejs.checkLatest(depsPath):
    ltsReleases = fetch nodejs.org/dist/index.json, keep { version, lts !== false }
    manifest = await NodePtyResolver.loadManifest(depsPath)
    if manifest is null:
        log.warn('Prebuilt manifest unavailable; Node update gating skipped')
        return ltsReleases[0].version.replace(/^v/, '')   // today's behavior
    supportedMajors = set of major numbers from manifest entries matching
        { platform: getPlatform(), arch: getArch() }        // existing helpers
    candidates = ltsReleases.filter(r => supportedMajors.has(parseMajor(r.version)))
    if candidates.length === 0:
        return null    // resolveStatus will leave status as Unknown
    latestFiltered = candidates[0]
    if ltsReleases[0].version !== latestFiltered.version:
        log.warn(`Node ${strippedV(ltsReleases[0].version)} available but no
                  matching node-pty prebuilt; staying on filter max
                  ${strippedV(latestFiltered.version)}`)
    return strippedV(latestFiltered.version)
```

### Edge rules (confirmed during brainstorm)

1. **Never auto-downgrade.** In `DependencyManager.resolveStatus`, if `compareVersions(installedVersion, latestFiltered) > 0`, force status to `UpToDate` (not `UpdateAvailable`). The Option D filter can, in theory, produce a filtered latest that is older than the installed version — e.g., if the user hand-installed a Node major that we later dropped from our matrix. In that case, we leave the user alone; a single INFO line notes the condition.

2. **Silent skip** of majors without a prebuilt. The `UpdateAvailable` state only fires against the filtered latest. There is no UI surface for "pending prebuilt"; the user sees `UpToDate` and the server-side WARN is the only signal.

3. **No force-update.** There is no API, CLI flag, config key, or UI element that bypasses the filter. A user wanting Node X that lacks a prebuilt must wait for the matrix to catch up, or install Node X by hand outside `dependencies/` (which the dep-manager will then overwrite on its next update cycle — unavoidable cost of the "managed" design).

### First-run corner

On fresh install before SP1b's resolver has ever populated `dependencies/manifest.json`, `loadManifest()` returns `null`. The pseudocode above falls back to today's unfiltered behavior with a WARN. Once SP2b ships first-run bootstrap, the manifest will always exist by the time `checkLatest()` runs.

### Why reuse SP1b's manifest

Not a new network call. `NodePtyResolver.loadManifest()` already caches the manifest at `<depsPath>/manifest.json` with a staleness check. The same cache serves the runtime `require('node-pty')` resolver and the update-gate check — one source of truth, no drift.

---

## 5. Logging coverage

`const log = Logger.for('DependencyManager');` at module scope (matching the `src/server/ScrcpyConnection.ts:22` / `NodePtyResolver.ts:10` pattern).

Events and levels:

| Event | Level | Example log line |
|---|---|---|
| `checkAll` complete | INFO | `Dependency check complete: 1 update available (nodejs), 2 up-to-date` |
| Single-dep check failure | WARN | `Latest-version check failed for adb: network timeout` |
| Option D skip | WARN | `Node 26.0.0 available but no matching node-pty prebuilt; staying on filter max 24.14.1` |
| Manifest unavailable | WARN | `Prebuilt manifest unavailable; Node update gating skipped` |
| No-downgrade hold | INFO | `Installed nodejs 26.0.0 is newer than filtered latest 24.14.1; staying put` |
| Update start | INFO | `Updating nodejs: 22.11.0 → 24.14.1` |
| Update complete | INFO | `Updated nodejs to 24.14.1 (restart queued)` |
| Update failure | ERROR | `Update nodejs failed: HTTP 403 from nodejs.org` |
| Restart requested | INFO | `Restart requested; writing marker at <path> and exiting with code 75` |

Explicitly **not** logged:
- Individual `checkInstalled` / `checkLatest` successes (noise — the aggregate line covers this).
- Download-byte progress or per-chunk status.
- Extraction-phase transitions (unzip / tar / copy).

---

## 6. Testing plan

### New unit tests (vitest, in `src/server/__tests__/`)

1. **`config.depsPath.test.ts`**
   - `DEPS_PATH` env wins over every other source.
   - `fileConfig.dependenciesPath` is used when env is absent.
   - Dev fallback resolves `../dependencies` only when `../package.json` is present.
   - Throws a clear startup error when no source resolves AND the dev-layout tell is missing.

2. **`dependencyDefinitions.nodejs.test.ts`**
   - Filter logic: given a synthetic LTS list and a synthetic manifest, the newest surviving release is returned.
   - No-downgrade: when `loadManifest` returns only old majors and installed is newer, the newer installed version is preserved (`resolveStatus` leaves `UpToDate`).
   - `loadManifest === null` falls back to unfiltered behavior and emits the WARN log.
   - `loadManifest` returns a manifest with zero matches for current `{platform, arch}`: returns `null` (status stays `Unknown`).

3. **`dependencyManager.requestRestart.test.ts`**
   - Marker file is written at `<depsPath>/.restart` with a timestamped body.
   - `process.exit` is called with code `75` (injected exit function for test isolation).
   - Marker path does NOT fall at `dirname(depsPath)` (regression guard).

### Manual verification (shell scripts not easily unit-tested)

- `start.cmd` loop on Windows: set `DEPS_PATH`, run the script, write a `.restart` marker manually, observe that `cmd.exe` loops.
- `start.cmd` loop via exit code 75: temporarily patch `dist/index.js` to `process.exit(75)`, confirm loop.
- `start.sh` loop on Linux: same two checks.
- End-to-end via UI: click "Update Node" in the dep panel (if an update happens to be available), observe the restart marker, confirm loop, confirm new version reports after restart.

### Regression sweep

All existing tests (311 at SP1b merge) must continue passing. `NodePtyResolver` tests cover manifest loading — we are adding a new consumer, not modifying manifest semantics. `DependencyManager` tests (if they exist) must be updated to assert new marker location and exit code.

### CHANGELOG

A single `[Unreleased] → Changed` entry covering:
- `DependencyManager.requestRestart` marker location (`<depsPath>/.restart`) and exit code (`75`).
- `Config.dependenciesPath` resolution is now strict; `DEPS_PATH` is required in production.
- `DependencyDefinitions.nodejs.checkLatest` is now gated by the node-pty prebuilt manifest (Option D).
- Launcher scripts (`start.cmd`, `start.sh`) read the marker from `$DEPS_PATH/.restart` and also loop on exit code `75`.

A single `[Unreleased] → Added` entry covering `Logger.for('DependencyManager')` coverage at Medium granularity.

---

## 7. Open questions (resolved during brainstorm)

For the record — each of the roadmap's open questions for SP2 is now answered:

| Roadmap question | Resolution |
|---|---|
| First-run bootstrap UX (block vs "setting up" page, offline fallback, Node floor) | Punted to SP2b; out of SP2 scope. |
| `depsPath` correct in dev / Velopack / Docker | Explicit `DEPS_PATH` env; dev-only auto-fallback; hard-fail otherwise. |
| Restart-signal supervisor-aware | File marker at `<depsPath>/.restart` + exit code 75. |
| `Logger.for` coverage verification | Medium granularity; specific event list in §5. |

## 8. Non-goals reinforced

- No new REST endpoints.
- No new websocket messages.
- No client-side changes in `DependencyPanel.ts`. The UI continues to render whatever status `DependencyInfo` reports; Option D is entirely server-side.
- No changes to `DependencyTypes.ts` enum values or the `DependencyInfo` shape.
- No cross-platform unification of zip / tar / copy logic beyond what already exists.

---

## 9. Sequencing into SP3 / SP4

SP2's deliverables are pre-conditions for SP3 and SP4 but do not require either to ship:

- **SP3 Velopack** will consume: the `DEPS_PATH` contract (installer sets it in the app stub), the exit-code-75 restart convention (service wrapper / stub handles it), and the sibling-of-`current/` layout (installer drops nothing into `dependencies/`, leaves it mutable).
- **SP4 Docker** will consume: the `DEPS_PATH` contract (ENV in the Dockerfile), the `start.sh` loop as ENTRYPOINT, the named-volume layout, and the manifest-gated Node policy (so container rebuilds don't race the prebuilt matrix).

The design deliberately leaves supervisor choice (start-script wrapping vs native systemd vs bare Docker restart policy) to SP3/SP4 by emitting both signals.
