# SP1 — Dependency Modernization

Design spec for Sub-Project 1 of ws-scrcpy-web. Strip dead features, modernize dependencies, update build tooling, add CI/CD and Dockerfile. No behavior changes — existing scrcpy v1.19 functionality must still work end-to-end.

## Scope

1. **Feature stripping** — remove iOS support, Chrome DevTools proxy, multi-device tracker, vendor directory (Broadway/TinyH264/h264-converter decoders), ifdef conditional compilation
2. **Dependency reduction** — 39 packages down to ~16. Drop adbkit (build own ADB client), Express (built-in http), and 20+ other packages replaced by built-ins or eliminated
3. **Dependency upgrades** — TypeScript 5.5, Node 22 types, webpack-cli 5, xterm v5 (@xterm/ scope)
4. **New tooling** — Biome (replaces ESLint + Prettier), JSON config (replaces YAML)
5. **Build system updates** — webpack config cleanup, built-in asset modules, handwritten index.html
6. **CI/CD** — GitHub Actions workflow for lint + build
7. **Dockerfile** — container-ready from day one

## Feature Stripping

### Remove entirely

| What | Why |
|------|-----|
| `src/app/applDevice/` | iOS support — not needed, heavy deps |
| `src/server/appl-device/` | iOS server handlers |
| `typings/` | Appium type definitions (iOS only) |
| `vendor/` | Entire directory — Broadway, tinyh264, h264-live-player. WebCodecs replaces all. |
| DevTools proxy code (client + server) | Available natively via Chrome, not relevant |
| Multi-device tracker UI | Single-device, on-demand use |
| `BroadwayPlayer.ts` | Replaced by WebCodecs |
| `TinyH264Player.ts` | Replaced by WebCodecs |
| `MsePlayer.ts` | Replaced by WebCodecs |
| All `#ifdef` directives | No conditional compilation needed after stripping |
| `config.example.yaml` | Replaced by JSON config |

### Keep

| What | Why |
|------|-----|
| `src/app/player/WebCodecsPlayer.ts` + `BaseCanvasBasedPlayer.ts` | The one video decoder |
| `src/app/googDevice/` | Android stream client, toolbox (touch/key/clipboard) |
| `src/server/goog-device/` | ADB bridge, scrcpy server management |
| Shell client + server (xterm.js + node-pty) | Remote ADB shell in browser |
| File manager client + server | Browse, upload, download, APK push |
| `src/common/` | Shared types, constants |

## Dependency Changes

### Runtime Dependencies (9 → 3)

| Package | Action | Replacement |
|---------|--------|-------------|
| `@dead50f7/adbkit` | **Drop** | Build own `AdbClient` class using `child_process` to shell out to `adb` CLI |
| `express` | **Drop** | Node's built-in `http` module + ~20 line static file server |
| `ios-device-lib` | **Drop** | iOS removed |
| `node-mjpeg-proxy` | **Drop** | iOS removed |
| `node-pty` | **Keep** | Microsoft-maintained, powers terminal |
| `portfinder` | **Drop** | Fixed configurable port via JSON config |
| `tslib` | **Drop** | Set `importHelpers: false` in tsconfig, inline helpers |
| `ws` | **Keep** | De facto WebSocket library, no alternative |
| `yaml` | **Drop** | JSON config via native `JSON.parse()` |

New runtime: `ws`, `node-pty`

### Dev Dependencies (30 → ~13)

**Keep (upgraded):**

| Package | From | To |
|---------|------|----|
| `@types/node` | ^12.20.47 | ^22 |
| `@types/ws` | ^7.4.7 | ^8 |
| `css-loader` | ^6.8.1 | latest |
| `mini-css-extract-plugin` | ^2.6.1 | latest |
| `ts-loader` | ^9.3.1 | latest |
| `ts-node` | ^10.9.1 | latest |
| `typescript` | ^4.7.4 | ^5.5 |
| `webpack` | ^5.94.0 | latest |
| `webpack-cli` | ^4.10.0 | ^5 |

**Add:**

| Package | Purpose |
|---------|---------|
| `@biomejs/biome` | Linter + formatter (replaces ESLint, Prettier, and 4 plugins) |
| `@xterm/xterm` | Terminal emulator v5 (replaces `xterm`) |
| `@xterm/addon-attach` | WebSocket terminal addon (replaces `xterm-addon-attach`) |
| `@xterm/addon-fit` | Auto-resize addon (replaces `xterm-addon-fit`) |

**Drop:**

| Package | Reason |
|---------|--------|
| `@dead50f7/generate-package-json-webpack-plugin` | Write own build script |
| `@types/bluebird` | adbkit removed |
| `@types/dom-webcodecs` | Built into TypeScript 5.1+ DOM lib |
| `@types/express` | Express removed |
| `@types/node-forge` | Unused (zero references in src/) |
| `@types/npmlog` | adbkit removed |
| `@types/webpack-node-externals` | Package replaced by inline regex |
| `@typescript-eslint/eslint-plugin` | Replaced by Biome |
| `@typescript-eslint/parser` | Replaced by Biome |
| `buffer` | Keep for SP1 (19 files use Buffer). Refactor to Uint8Array in SP2 alongside path-browserify. |
| `cross-env` | Unused in npm scripts |
| `eslint` | Replaced by Biome |
| `eslint-config-prettier` | Replaced by Biome |
| `eslint-plugin-prettier` | Replaced by Biome |
| `eslint-plugin-progress` | Unmaintained, unnecessary |
| `file-loader` | Replaced by webpack 5 `asset/resource` |
| `h264-converter` | MSE player removed |
| `html-webpack-plugin` | Handwritten index.html |
| `ifdef-loader` | Conditional compilation removed |
| `mkdirp` | `fs.mkdirSync({ recursive: true })` built-in |
| `path-browserify` | Keep for SP1, drop in SP2 |
| `prettier` | Replaced by Biome |
| `recursive-copy` | `fs.cpSync({ recursive: true })` built-in |
| `rimraf` | `rm -rf` in npm script |
| `svg-inline-loader` | Replaced by webpack 5 `asset/source` |
| `sylvester.js` | Only used in vendor/ (deleted) |
| `tinyh264` | Decoder removed |
| `webpack-node-externals` | Replaced by `externals: [/^[a-z@]/]` |
| `worker-loader` | TinyH264 worker removed |
| `xterm` | Replaced by `@xterm/xterm` |
| `xterm-addon-attach` | Replaced by `@xterm/addon-attach` |
| `xterm-addon-fit` | Replaced by `@xterm/addon-fit` |

## Build System Updates

### package.json

- Name: `ws-scrcpy-web`
- Version: `1.0.0`
- License: `GPL-3.0-only`
- Engines: `{ "node": ">=18" }`
- Scripts:
  - `clean`: `rm -rf dist`
  - `build:dev`: `webpack --config webpack/ws-scrcpy-web.dev.ts`
  - `build`: `webpack --config webpack/ws-scrcpy-web.prod.ts`
  - `start`: `npm run build && node dist/index.js`
  - `lint`: `biome check src/`
  - `format`: `biome check --write src/`

### tsconfig.json

- `target`: `ES2022` (modern Node 18+ and browsers)
- `module`: `ES2022`
- `lib`: `["ES2022", "DOM", "DOM.Iterable"]` (includes WebCodecs types)
- `importHelpers`: `false`
- `strict`: `true`

### Webpack config

- Rename files: `ws-scrcpy.*.ts` → `ws-scrcpy-web.*.ts`
- Remove: `ifdef-loader`, `worker-loader`, `file-loader`, `svg-inline-loader`, `html-webpack-plugin`, `webpack-node-externals` import
- Replace `file-loader` rules with `type: 'asset/resource'`
- Replace `svg-inline-loader` rules with `type: 'asset/source'`
- Replace `externals: [nodeExternals()]` with `externals: [/^[a-z@]/]`
- Keep `buffer` and `path-browserify` in `resolve.fallback` for SP1 (both drop in SP2 with protocol rewrite)
- Remove all ifdef-loader conditional compilation flags from `build.config.override.json` and `default.build.config.json`
- Handwrite `public/index.html` that loads `bundle.js` and `bundle.css`

### Config format

- Delete `config.example.yaml`
- Create `config.example.json`: `{ "port": 8000, "adbPath": "adb" }`
- Server reads via `JSON.parse(fs.readFileSync(configPath))` with env var overrides (`PORT`, `ADB_PATH`)

### Biome setup

- `biome.json` at project root
- Match existing code style (check current `.prettierrc` for settings)
- Delete `.eslintrc`, `.prettierrc`

## ADB Client

Replace `@dead50f7/adbkit` with a thin `AdbClient` class that shells out to the `adb` CLI via `child_process`.

Required operations (used by existing server code):
- `adb devices` — list connected devices
- `adb -s <serial> push <local> <remote>` — push scrcpy-server to device
- `adb -s <serial> forward tcp:<port> localabstract:<name>` — port forwarding
- `adb -s <serial> shell <command>` — run commands on device
- `adb -s <serial> reverse <remote> <local>` — reverse port forwarding
- `adb -s <serial> get-prop <prop>` — read device properties
- `adb -s <serial> pull <remote> <local>` — pull files from device

Interface: methods that return `Promise<string>` (stdout) or `Promise<void>`, using `child_process.execFile` with proper error handling.

## HTTP Server

Replace Express with Node's built-in `http` module.

- Serve static files from `dist/public/` with correct MIME types
- Attach `ws` WebSocket server to the same `http.Server`
- ~20-30 lines of code for the static file server
- Support `config.json` port setting and `PORT` env var override

## CI/CD

`.github/workflows/ci.yml`:
- Trigger: push to `main`, pull requests
- Node 18
- Steps: checkout → install → lint (`biome check`) → build (`npm run build`)

## Dockerfile

```dockerfile
FROM node:18-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    android-tools-adb python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 8000
CMD ["node", "dist/index.js"]
```

`.dockerignore`: `node_modules`, `dist`, `.git`

## New Files

| File | Purpose |
|------|---------|
| `src/server/AdbClient.ts` | Own ADB CLI wrapper (replaces adbkit) |
| `src/server/HttpServer.ts` | Built-in http static file server (replaces Express) |
| `public/index.html` | Handwritten HTML entry point |
| `config.example.json` | JSON config template |
| `biome.json` | Biome linter/formatter config |
| `.github/workflows/ci.yml` | GitHub Actions CI |
| `Dockerfile` | Container build |
| `.dockerignore` | Docker ignore rules |

## Modified Files

| File | Change |
|------|--------|
| `package.json` | Full overhaul — name, deps, scripts, engine |
| `tsconfig.json` | ES2022 target, strict mode, drop helpers |
| `webpack/ws-scrcpy-web.common.ts` | Remove dead loaders, update asset handling |
| `webpack/ws-scrcpy-web.dev.ts` | Rename + update |
| `webpack/ws-scrcpy-web.prod.ts` | Rename + update |
| `src/server/index.ts` | Use new HttpServer, remove npmlog/adbkit imports |
| `src/app/index.ts` | Remove ifdef blocks, remove dead decoder registrations |
| All files importing from adbkit | Switch to AdbClient |
| All files importing old xterm | Switch to @xterm/ packages |

## Deleted Files/Directories

| Path | Reason |
|------|--------|
| `vendor/` | All WASM decoders replaced by WebCodecs |
| `src/app/applDevice/` | iOS removed |
| `src/server/appl-device/` | iOS removed |
| `typings/` | Appium types (iOS) |
| `src/app/player/BroadwayPlayer.ts` | Decoder removed |
| `src/app/player/TinyH264Player.ts` | Decoder removed |
| `src/app/player/MsePlayer.ts` | Decoder removed |
| DevTools proxy files | Feature removed |
| `config.example.yaml` | Replaced by JSON |
| `.eslintrc` | Replaced by Biome |
| `.prettierrc` | Replaced by Biome |
| `webpack/default.build.config.json` | ifdef flags no longer needed |
| `build.config.override.json` | ifdef flags no longer needed |

## Testing

- **Build verification:** `npm run build` succeeds with zero errors
- **Lint:** `biome check src/` passes
- **Docker:** `docker build -t ws-scrcpy-web .` succeeds
- **Smoke test:** Start server, connect to Android device, verify screen mirroring works end-to-end with WebCodecs decoder

## What SP1 Does NOT Change

- scrcpy protocol (still v1.19-ws7 patched server)
- Video stream handling (beyond removing dead decoders)
- Control message format
- `Buffer` usage in client code (refactored in SP2)
- `path-browserify` dependency (dropped in SP2)
- No new features — behavior-preserving modernization only
