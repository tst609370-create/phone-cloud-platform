# ws-scrcpy-web Installer + Docker Roadmap

**Date:** 2026-04-21
**Status:** Approach approved; sub-projects pending individual brainstorming + tactical plans
**Predecessor memories:** `project_installer_plan.md`, `project_wsscrcpy_todo.md`

---

## What this document is

A roadmap. Locks in the **architectural decisions** made during the 2026-04-21 discussion and enumerates the sub-projects needed to deliver them. This is **not** a tactical implementation plan — each sub-project gets its own brainstorming session and tactical plan in `docs/superpowers/plans/` before coding starts.

## What this document is NOT

- Not a task-by-task implementation plan.
- Not a contract — design details will be revisited during each sub-project's own brainstorming.
- Not a schedule. Ordering is about dependency, not calendar.

---

## Decisions locked in

### D1. Installer and Docker are one initiative, two phases

Previously tracked as separate TODO items 2 and 3. Merged because the existing `DependencyManager` / `DependencyDefinitions` code in `src/server/` already handles Node + ADB + scrcpy-server auto-update, and that code path serves **both** host installs and Docker containers with identical behavior — the only requirement is that `dependencies/` be a writable location. So the per-platform packaging work (Phase A) and the container work (Phase B) share one upstream (the dep manager + node-pty prebuilt matrix) and differ only at the outer shell.

**Consequence:** `project_wsscrcpy_todo.md` items 2 and 3 merge into a single "Installer + Docker" track; multi-device dashboard stays out of scope per existing policy.

### D2. Earlier concern about "Node auto-update in Docker is hard" is retracted

Upon re-examination of `src/server/DependencyDefinitions.ts:46-70`, the Node update mechanism is fully platform-agnostic:
- Downloads platform-specific archive (tar.gz / zip)
- Extracts into `depsPath/node/`
- Restarts the server process (already supported via the `.restart` marker / start-loop pattern in `start.cmd`)

Running that inside a container is not harder than running it on a host. The container just needs:
1. A writable volume mounted at `dependencies/`
2. An in-container supervisor (tini + a shell script that mirrors the existing `start.cmd` restart-marker loop)
3. node-pty prebuilt compatible with the post-update Node ABI (which is a concern on host too — it's not Docker-specific)

The "standard Docker" objection — that images should be immutable — is style, not blocker. This app's container is intentionally a persistent environment (devices, labels, logs, dependencies) not a stateless replica.

### D3. Installer packaging uses Velopack

Chosen over raw platform zips, `pkg`, and Node SEA because:
- **Cross-platform from one spec** — Windows (MSIX/Squirrel) + Linux Debian family (`.deb` for Ubuntu / Debian / Mint / etc.) + Linux RHEL family (`.rpm` for Fedora / RHEL / CentOS / Rocky / Alma / openSUSE) + portable AppImage, all from the same `vpk pack` invocation
- **App self-update built in** — today the dep manager updates Node / ADB / scrcpy, but NOT the app's own code. Velopack fills that gap with delta updates.
- **GitHub Releases as the update feed** — no separate release server to run
- **Background-service install supported** — fits this headless-server use case (no desktop UI window)
- **Mature pedigree** — Paul Betts (Squirrel.Windows → Clowd.Squirrel → Velopack)

macOS target is out per existing `feedback_no_macos.md` policy.

### D4. node-pty prebuilt matrix is the shared foundation

Both phases depend on this. node-pty compiles against Node's C++ ABI; an auto-Node-update across an ABI break would orphan the currently-installed node-pty. Resolution: ship a matrix of node-pty prebuilts keyed by `{platform, arch, nodeMajor}`, select the right one after every Node update.

This is infrastructure that lives upstream of both Phase A and Phase B and should land first.

### D5. Dependency folder is the runtime contract

Both phases treat `dependencies/` as the authoritative location for managed binaries (Node, ADB, scrcpy-server, node-pty prebuilts). Host install: `dependencies/` sits alongside the Velopack app root. Docker: `dependencies/` is mounted as a named volume so dep-manager updates survive container recreation.

---

## Sub-projects

Each of these gets its own brainstorming session + tactical plan. Ordering below is by dependency, not priority.

### SP1. node-pty prebuilt matrix (foundation)

**Scope:** Build and publish node-pty prebuilts for the target matrix, integrate matrix-aware resolution into the app startup path.

**Deliverables:**
- Pre-built node-pty binaries for: Windows x64, Windows arm64, Linux x64 (glibc), Linux arm64 (glibc), Linux x64 (musl for Alpine containers) — across the Node major versions the dep-manager will target (current LTS + one lookback).
- App startup logic that picks the correct prebuilt based on `process.platform` + `process.arch` + `process.versions.node` + libc flavor.
- Fallback path: if no matching prebuilt is available (e.g. user ran a Node update to a brand-new major), fall back to the pinned Node that ships bundled and log the gap.
- A CI workflow that produces the matrix on every node-pty upstream bump.

**Open design questions (bring to brainstorming):**
- Where do prebuilts live? Bundled in the app release? Downloaded on demand? GitHub Releases attachments?
- glibc vs musl detection on Linux — `ldd` probe? Known-path heuristic?
- Do we pin node-pty itself to a specific version, or track upstream?
- What's the behavior when Node updates and no matching prebuilt exists yet? Block the Node update? Warn but allow?

### SP2. Dep-manager polish (foundation)

**Scope:** Small hardening of the existing dep manager to meet the expanded install/Docker surface.

**Deliverables:**
- `depsPath` resolution that works correctly in (a) dev checkout, (b) Velopack host install, (c) Docker mounted volume.
- Restart-signaling primitive generalized: today `start.cmd` watches for `.restart` marker on Windows. Mirror as `start.sh` on Linux, make both signal supervisors (Velopack service wrapper, tini inside Docker).
- Per-dependency update logging consistent with `Logger.for()` pattern (most of this exists, verify coverage).
- First-run bootstrap: the three managed binaries (Node, ADB, scrcpy-server) are NOT shipped with the app anymore — they download on first start, with a UI showing progress. This reduces install payload dramatically and guarantees every install starts on latest versions.

**Open design questions:**
- Does first-run bootstrap block the UI entirely, or serve a "setting up" page from a minimal bootstrap Node? Implementation detail but UX-affecting.
- If the update feed is unreachable on first run (no internet), what happens? Retry loop? Manual instructions?
- Node version floor: does the dep-manager auto-advance to the latest LTS, or does it follow a pin we control? (Today it auto-advances.)

### SP3. Phase A — Velopack installer

**Scope:** Package the app for Windows + Linux using Velopack, with auto-update of the app itself against GitHub Releases.

**Deliverables:**
- `vpk.config` (or equivalent) in the repo
- `npm run package:win` / `npm run package:linux` / `npm run package:all` scripts
- Release CI that builds the Velopack artifacts on every tagged release and uploads to GitHub Releases in the format Velopack's updater expects
- Signed Windows installer (code signing cert required; may be a follow-up)
- `.deb` (Debian/Ubuntu family) + `.rpm` (Fedora/RHEL family) + AppImage (portable fallback for any distro) — all three for Linux; Velopack emits them from one spec
- Velopack updater invocation on app startup: check feed, stage update if available, apply on next restart

**Open design questions:**
- Where does the app install to on Windows? `%LOCALAPPDATA%` (per-user) vs `%PROGRAMFILES%` (machine-wide)? Velopack default is per-user; that avoids UAC.
- Linux packaging mix: `.deb` for Debian family, `.rpm` for RHEL family, AppImage as portable fallback. Ship all three, or just the distro-native pair (deb + rpm) and skip AppImage? Or ship all three and let the user pick based on preference?
- Linux validation coverage: at minimum one Debian-family distro (Ubuntu LTS) and one RHEL-family distro (Fedora current) need real-hardware test passes before release. AppImage as the "works everywhere else" safety net.
- What's the update cadence? Velopack supports "check every N hours"; is app-startup-only enough?
- Running as a service on Linux — systemd unit shipped with the install? Or user-launched only?
- Running as a service on Windows — Windows service vs Startup entry vs nothing?
- Release feed: GitHub Releases directly, or a separate `velopack.json` manifest file in a repo branch?

### SP4. Phase B — Docker image

**Scope:** Multi-stage Dockerfile + compose example, with the dep-manager managing the inner runtime in a persistent volume.

**Deliverables:**
- Multi-stage `Dockerfile`: `builder` stage (Node + npm ci + webpack build) → `runtime` stage (Alpine or Debian-slim + ADB + tini + the built `dist/`).
- `docker-compose.yml` example showing the `dependencies/` volume, the `device-labels.json` volume, and the log mount.
- Startup script (`start.sh`) that mirrors `start.cmd`'s restart-marker loop so the dep-manager's restart signal works in-container.
- ADB baked into the image at build time (so first-start works offline), but the dep-manager can still update it in the mounted volume if desired.
- Multi-arch image (linux/amd64 + linux/arm64) via `docker buildx`.
- Documented "two update modes":
  1. **Image-rebuild:** user runs `docker pull && docker-compose up -d` — gets fresh Node/ADB/scrcpy from the new image. Standard Docker idiom.
  2. **Live-in-container:** the dep-manager's UI in the running app updates Node/ADB/scrcpy without touching the image. Persistent volume makes it survive.

**Open design questions:**
- Alpine (musl libc, smallest image) vs Debian-slim (glibc, better node-pty prebuilt story). Trade-off resolves based on SP1's libc decision.
- Do we bundle a `scrcpy` CLI binary too, or just scrcpy-server for push-to-device? (The app only needs scrcpy-server on the device; the server doesn't execute scrcpy locally.)
- Published where? Docker Hub, GHCR, both? GHCR aligns with the GitHub Releases installer flow.
- Health check endpoint in the image? (The app already listens on :8000; a `GET /healthz` or similar would be trivial.)

### SP5. Docs + release runbook

**Scope:** Update README + TECHNICAL_GUIDE for the new install/update story; write a release runbook.

**Deliverables:**
- README gets a "Install" section with three paths: Windows installer, Linux installer, Docker.
- TECHNICAL_GUIDE gets a "Packaging & updates" chapter covering the dep-manager, Velopack config, node-pty matrix, and Docker image layers.
- `RELEASING.md` runbook: tag, CI cuts the Velopack + Docker artifacts, both go live on GitHub Releases + GHCR.
- CHANGELOG entries for each sub-project as it ships.

---

## Ordering

```
SP1 (node-pty matrix)  ──┬──► SP3 (Velopack installer)  ──┐
                         │                                 ├──► SP5 (docs + runbook)
SP2 (dep-manager polish)─┴──► SP4 (Docker image)         ──┘
```

SP1 and SP2 are independent of each other but both block SP3 and SP4. SP3 and SP4 are independent once SP1+SP2 land. SP5 wraps when SP3 and SP4 are both out the door.

Reasonable cadence: SP1 → SP2 → SP3 (Velopack visible user win) → SP4 (Docker) → SP5 (docs). Or SP1 → SP2 → SP4 first if you prefer the Docker-first validation story. Either order works.

---

## What happens next

For each sub-project in order:
1. **Brainstorm** — resolve the open design questions listed above for that sub-project. Output: `docs/superpowers/specs/YYYY-MM-DD-<subproject>-design.md`.
2. **Plan** — tactical step-by-step implementation plan. Output: `docs/superpowers/plans/YYYY-MM-DD-<subproject>.md`.
3. **Execute** — subagent-driven or inline, with review checkpoints.

This roadmap is intentionally high-level so that each sub-project can evolve its own details without re-litigating the big picture.

## Explicitly out of scope

- Multi-device dashboard view (paid contract work only; see `project_wsscrcpy_todo.md`).
- macOS installer target (`feedback_no_macos.md`).
- Web-hosted deployment (remote multi-user) — this project is single-tenant-local-network by design.
- Scanner port to Control Menu — being done directly in Control Menu repo (see `project_wsscrcpy_todo.md` update 2026-04-21).
