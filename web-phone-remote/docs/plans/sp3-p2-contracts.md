# SP3 P2 — Locked Contracts (lead-authored, agents must comply)

> **Read this before editing any file.** Three agents (rust / backend / frontend) are working in parallel on `sp3-p2-hooks-lifecycle`. These contracts define the integration surface; deviation from them WILL break the round-trip validation at the end.

**Companion docs:**
- Spec: `docs/specs/2026-04-26-sp3-velopack-installer.md`
- Plan: `docs/plans/2026-04-26-sp3-velopack-installer.md` (P2 section)

---

## Plan-vs-reality drifts (READ FIRST)

The P2 plan was written before this codebase walk. Three corrections supersede the plan's "Create" actions:

1. **`src/server/Config.ts` already exists** (singleton, `Config.getInstance()`, dep-resolver, `port`/`adbPath`/`dependenciesPath`/scan tuning fields). Backend agent must **EXTEND** this file, not replace it. The new SP3 fields layer on top of the existing schema. The plan's `webPort` field unifies with the existing `port` getter — see schema section below for the merged layout.
2. **`src/server/main.ts` does not exist** — server entry is `src/server/index.ts`. `VelopackApp.build().run()` goes at the very top of `index.ts`, before any other import side-effect can run. Backend agent owns this edit.
3. **`src/app/client/AndroidPowerTools.ts` does not exist** — frontend entry is `src/app/index.ts`. WelcomeModal mounts inside the existing `window.onload` handler, after `FirstRunBanner` is appended (so banner + modal can coexist if both apply). Frontend agent owns this edit.

`Cargo.toml` workspace already has `serde`, `serde_json`, `anyhow`, `ctrlc`, `windows`. Rust agent must add the **`velopack`** crate to `[workspace.dependencies]` and reference it from `launcher/Cargo.toml`. Backend agent must add the **`velopack`** npm package to `package.json` `dependencies`.

The `Modal` base class lives at `src/app/ui/Modal.ts` (abstract class with `buildBody(bodyEl)` hook — see `feedback_es2022_class_fields.md`: NEVER store on `this.foo = bar` from `buildBody()`; class fields run AFTER super(), so anything assigned during buildBody is clobbered. Use protected fields declared with `!: T` or initialize inside an explicit `init()` called by subclass).

---

## Contract 1 — `config.json` schema (single source of truth)

**File location at runtime:** `<installRoot>/config.json` (sibling of `current/`, survives updates). In dev: `<repoRoot>/config.json` (gitignored).

**Owner:** backend agent (read + write + migrate). Rust agent: read-only access via `launcher/src/config.rs` for service-mode hook decisions only.

**Schema (TypeScript source of truth):**

```ts
// in src/server/Config.ts (extend the existing FlatConfig + Config class)

export interface AppConfig {
    // SP3 lifecycle fields (NEW)
    installMode: 'user' | 'user-service' | 'system' | 'system-service' | null;
    firstRunComplete: boolean;
    autoUpdate: boolean;
    updateCheckIntervalMinutes: number;
    channel: 'stable' | 'beta';
    githubOwner: string;

    // Pre-existing fields (KEEP working — these are read by the running server today)
    webPort: number;            // unified name; alias of legacy `port`. On read, prefer webPort then fall back to port.
    dependenciesPath?: string;
    adbPath?: string;
    scanConcurrency?: number;
    scanTcpTimeoutMs?: number;
    scanAdbConnectTimeoutMs?: number;
    scanProgressInterval?: number;

    // Advanced (untouched)
    server?: ServerItem[];
}
```

**Defaults (when key absent):**

| Key | Default |
|---|---|
| `installMode` | `null` |
| `firstRunComplete` | `false` |
| `autoUpdate` | `true` |
| `updateCheckIntervalMinutes` | `60` |
| `channel` | `"stable"` |
| `githubOwner` | `"bilbospocketses"` |
| `webPort` | `8000` |
| `dependenciesPath` | resolved by existing `resolveDependenciesPath()` (DEPS_PATH env → config → dev fallback) |

**Migration rule:** if `webPort` is absent but legacy `port` is present, copy `port` → `webPort` in memory; do NOT rewrite the file unless another save happens for an unrelated reason. (Avoids surprise file-touches.)

**Validation:**
- `webPort`: integer 1024..65535
- `updateCheckIntervalMinutes`: integer 5..1440
- `channel`: enum check
- `installMode`: enum check (or null)
- On validation failure during load: log a warning, fall back to defaults for the offending field, do not throw.

**Persistence semantics:**
- Writes are sync (`fs.writeFileSync`). Config changes are infrequent.
- Config file is created on first save if absent (do NOT pre-create on read).
- Pretty-printed JSON, 2-space indent, trailing newline (so git diffs are clean if user inspects).

**Rust read-only struct (`launcher/src/config.rs`):**

```rust
#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct AppConfig {
    pub install_mode: Option<String>,    // serde rename: "installMode"
    pub first_run_complete: bool,
    pub web_port: Option<u16>,
}
```

Use `serde(rename = "installMode")` etc. Only the three fields above are needed for hook decisions; ignore others. Missing file → return `AppConfig::default()`.

---

## Contract 2 — `ConfigApi` HTTP shape

**Owner:** backend agent. File: `src/server/api/ConfigApi.ts`. Register in `src/server/index.ts` alongside existing `HttpServer.addApiHandler(...)` calls.

**Endpoints:**

### `GET /api/config`
- Response 200: `application/json`, body = full `AppConfig` object (with defaults filled in for absent keys).
- No auth, same as existing APIs.

### `PATCH /api/config`
- Request: `Content-Type: application/json`, body = partial `AppConfig` (any subset of the keys).
- Validates each provided key per schema rules above. On failure: 400 with `{ error: string, field: string }`.
- On success: writes merged config to disk, broadcasts `config-update` (see Contract 3), responds 200 with:
  ```json
  {
    "config": { /* full updated AppConfig */ },
    "restartRequired": boolean
  }
  ```
- `restartRequired` = `true` when `webPort` changed (server bound to old port; needs restart for new port to take effect). All other fields apply live → `restartRequired = false`.

---

## Contract 3 — WebSocket broadcast events

**Owner:** backend (server-side push) + frontend (client-side subscribe).

**Mechanism:** existing `WebsocketMultiplexer` channel. Reserve a new channel byte for app-config events. Pick the next free byte after current MWs (`ScrcpyConnection`, `DeviceProbe`, `WebsocketMultiplexer`). Backend agent: scan `Mw.ts` and existing channel constants, allocate the next sequential byte, document it in `src/common/ConfigEvents.ts`.

Alternatively (simpler if no existing app-level event channel exists): expose a dedicated WS endpoint `/ws-config` that emits JSON text frames. Backend agent picks whichever is consistent with the existing dispatch pattern; document the choice in `src/common/ConfigEvents.ts`.

**Event payloads (JSON):**

```ts
// fired on server startup, also after PATCH /api/config save
{ type: 'config-update', config: AppConfig }

// fired ONCE on server startup, then never again until restart
{ type: 'first-run-status',
  firstRunComplete: boolean,
  portWasAutoShifted: boolean,
  webPort: number }
```

Frontend subscribes on app load. WelcomeModal listens for `first-run-status` to decide whether to mount.

**Open question for backend:** if the multiplexer channel approach is too heavy for one-shot-ish events, a simpler path: serve `first-run-status` as part of the initial `GET /api/config` response (extend the GET to include a top-level `runtime: { portWasAutoShifted, firstRunStatusFlag }` envelope). Decide based on what's natural — frontend agent's WelcomeModal mount logic should accept either path: poll `/api/config` once on load OR subscribe to a WS event. Both are acceptable; pick one and document.

---

## Contract 4 — Velopack hook arg dispatch

**Owner:** rust agent (launcher), backend agent (Node entry).

**Rust dispatch in `launcher/src/main.rs` BEFORE `supervisor::run()`:**

1. Parse `std::env::args()` for `--veloapp-install`, `--veloapp-updated`, `--veloapp-uninstall`.
2. If matched: route to `hooks.rs` handler; on completion, `std::process::exit(<code>)` — do NOT proceed to spawn Node.
3. Hook handlers run BEFORE `velopack::VelopackApp::build().run()` is called. (Velopack's hook contract: hooks return synchronously without entering the framework's runtime loop.)
4. If no hook arg: call `velopack::VelopackApp::build().run()` as the very first executable statement after logging init, THEN proceed to existing supervisor loop.

**Hook handler responsibilities (`launcher/src/hooks.rs`):**

| Flag | Action | Time budget |
|---|---|---|
| `--veloapp-install` | If `<installRoot>/config.json` absent: write skeleton (defaults from Contract 1). Exit 0. | 30s |
| `--veloapp-updated` | Read config; if `installMode` ends in `-service`: shell out to `<installRoot>/current/servy-cli.exe restart WsScrcpyWeb`, capture exit code, log. (P3 will actually bundle servy; for P2 it's OK if servy-cli.exe is absent — log + exit 0 in that case so update doesn't fail). | 15s |
| `--veloapp-uninstall` | If service: `servy stop` + `servy uninstall` (same fault-tolerance — if servy-cli absent, log + exit 0). Preserve user data (don't touch `dependencies/`, `config.json`, `logs/`). | 30s |

**Hook return code:** 0 = success. ≠0 fails the Velopack lifecycle event.

**Node-side (`src/server/index.ts`):** `VelopackApp.build().run()` from the `velopack` npm package is the very first executable statement (above the existing imports' side-effects? — imports run first by ES semantics, but `VelopackApp.build().run()` should be the first call after imports settle). Backend agent: place it as line 1 of the function body, OR as a top-level statement immediately after imports. The Velopack JS SDK does NOT need to react to hook args (Rust handles those); the Node call exists so the *running server* context is registered with Velopack for the update-flow APIs (P5). For P2, the call is wired but not exercised.

---

## Contract 5 — Cross-cutting (LEAD-enforced)

Both `launcher/src/main.rs` and `src/server/index.ts` MUST call `VelopackApp.build().run()` (Rust crate / npm package respectively) as the very first executable code path. Lead validation will grep for these calls and fail if missing.

This is non-negotiable. Velopack's invariants depend on it.

---

## File ownership matrix

| Agent | Owns (writes/edits) | Read-only (reads but never edits) |
|---|---|---|
| **rust** | `launcher/src/hooks.rs` (new), `launcher/src/config.rs` (new), `launcher/src/main.rs` (modify: add hook dispatch + VelopackApp call), `launcher/Cargo.toml` (add velopack + serde derives), `Cargo.toml` (workspace: add velopack to `[workspace.dependencies]`) | None of `src/**`. None of `tray/**` (P4 territory). |
| **backend** | `src/server/Config.ts` (extend), `src/server/__tests__/Config.test.ts` (new), `src/server/PortPicker.ts` (new), `src/server/__tests__/PortPicker.test.ts` (new), `src/server/api/ConfigApi.ts` (new), `src/server/index.ts` (modify: VelopackApp call, port collision detect, register ConfigApi, broadcast first-run-status), `src/common/ConfigEvents.ts` (new — event payload types + channel byte if used), `package.json` (add `velopack` dep) | None of `launcher/**`. None of `src/app/**`. |
| **frontend** | `src/app/client/WelcomeModal.ts` (new), `src/app/index.ts` (modify: mount WelcomeModal after FirstRunBanner), CSS for the welcome modal if needed (`src/style/welcome-modal.css` new + import in index.ts) | None of `src/server/**`. None of `launcher/**`. May read `src/common/ConfigEvents.ts` for type imports. |

**Hard rule:** if your agent prompt does not list a file as Owns, do NOT touch it. If you discover you need to, STOP and surface it via SendMessage to lead.

---

## Test discipline

- **Rust:** `cargo test --workspace` and `cargo clippy --workspace -- -D warnings` must remain green. New tests for argv parsing (hooks.rs) and config read (config.rs) — match the style of existing tests in `launcher/src/`.
- **Vitest:** new tests for `Config` extension (defaults, migration, validation, save round-trip), `PortPicker` (all-busy / first-busy / all-free), `ConfigApi` PATCH validation. Do not regress the 350 currently-passing tests.
- **TypeScript:** `npx tsc --noEmit` must remain clean.

---

## Acceptance criteria (lead validates after agents finish)

Per plan P2 § Acceptance criteria, repeated here for clarity:

- ✅ Launching server when `config.json` is absent: launcher hook (or backend defaults-on-read) creates a clean default config.
- ✅ Welcome modal appears on first run, dismisses correctly, never reappears after `firstRunComplete=true`.
- ✅ Port 8000 occupied → server starts on 8001, `portWasAutoShifted` flag flows to client, modal copy reflects auto-shift.
- ✅ vitest passes for `Config` extension + `PortPicker` + `ConfigApi`.
- ✅ Cargo tests pass for `hooks.rs` argv parsing + `config.rs` read.
- ✅ `cargo clippy --workspace -- -D warnings` clean.
- ✅ `npx tsc --noEmit` clean.
- ✅ Round-trip: backend writes config.json → Rust `config.rs` reads same file → fields match.
- ✅ Both `VelopackApp.build().run()` calls present (lead greps both entry points).

---

## When in doubt

Send a message to the lead. Do not silently improvise around an ambiguous contract. The cost of a 30-second clarification is far less than the cost of an integration mismatch surfacing at validation time.
