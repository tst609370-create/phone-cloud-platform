# SP3: Feature Additions — Design Spec

## Overview

SP3 extends ws-scrcpy-web with multi-codec support, UHID hardware input, and codebase modernization. Five sequential sub-projects, each building on the previous.

**Order:**
1. SP3-1: Buffer → Uint8Array + path-browserify removal
2. SP3-2: StreamReceiver cleanup + metadata probe
3. SP3-3: H.265/AV1 video codecs
4. SP3-4: AAC/FLAC/raw audio codecs
5. SP3-5: UHID keyboard/mouse

---

## SP3-1: Buffer → Uint8Array + path-browserify removal

### Goal

Eliminate the Node.js `Buffer` polyfill and `path-browserify` from the browser bundle. All browser-side binary code uses `Uint8Array` + `DataView`.

### Buffer Refactor

**New utility: `src/app/BinaryWriter.ts`**
- Wraps `DataView` with chainable methods: `.writeInt8()`, `.writeInt32BE()`, `.writeUInt32BE()`, `.writeUInt16BE()`, `.writeBigUInt64BE()`, etc.
- Constructor takes a size, returns `Uint8Array` via `.toUint8Array()`.
- Replaces the `Buffer.alloc(n)` + `buf.writeInt32BE(val, offset)` pattern in all control messages.

**New utility: `src/app/BinaryReader.ts`**
- Wraps `DataView` for reading: `.readInt8()`, `.readInt32BE()`, `.readUInt32BE()`, `.readUInt16BE()`, `.readBigUInt64BE()`, etc.
- Constructor takes `Uint8Array` (or `ArrayBuffer` + offset).
- Replaces `Buffer.readInt32BE()`, `.slice()`, etc. in DeviceMessage and StreamReceiver.

**Files to convert (10 total):**

Control messages (change `toBuffer(): Buffer` → `toUint8Array(): Uint8Array`):
- `KeyCodeControlMessage.ts` — explicit Buffer import
- `TextControlMessage.ts` — explicit Buffer import
- `TouchControlMessage.ts` — implicit via ProvidePlugin
- `ScrollControlMessage.ts` — implicit via ProvidePlugin
- `CommandControlMessage.ts` — implicit via ProvidePlugin, most complex (VideoSettings, clipboard, file push)

Protocol handling:
- `DeviceMessage.ts` — `fromBuffer()` → `fromRaw()`, uses BinaryReader
- `BaseDeviceTracker.ts` — channel init data
- `HostTracker.ts` — initialization messages
- `ManagerClient.ts` — channel init data

Note: `StreamReceiver.ts` also uses Buffer but is deleted in SP3-2 — skip converting it here.

**Interface update:**
- `ControlMessage.toBuffer()` → `ControlMessage.toUint8Array()` (single rename across the interface and all consumers)
- `ScrcpyDemuxer.sendControl()` already expects `ControlMessage` with `.toBuffer()` — update to `.toUint8Array()`

**Webpack cleanup:**
- Remove `ProvidePlugin({ Buffer: ['buffer', 'Buffer'] })` from `webpack/ws-scrcpy-web.common.ts`
- Remove `buffer` from package.json dependencies (if present as direct dep)

### path-browserify Removal

**Only consumer:** `FileListingClient.ts` uses `path.resolve()`, `.basename()`, `.dirname()`, `.join()`.

**New utility: `src/app/pathUtils.ts`** (~15 lines)
- ADB paths are always Unix-style (`/`-separated), so these are simple string operations.
- `resolve(base, name)` — handles `.` and `..`, normalizes slashes
- `basename(p)` — last segment after final `/`
- `dirname(p)` — everything before final `/`
- `join(...parts)` — concatenate with `/`, normalize

**Webpack cleanup:**
- Remove `resolve.fallback.path` from webpack config
- Remove `path-browserify` from package.json

---

## SP3-2: StreamReceiver Cleanup + Metadata Probe

### Goal

Delete `StreamReceiver.ts` and `StreamReceiverScrcpy.ts`. Replace with a lightweight metadata probe so ConfigureScrcpy retains encoder discovery, display enumeration, and connection feedback.

### New Server-Side Action: `probe`

**New file: `src/server/DeviceProbe.ts`** (extends Mw)
- Registered as a WebSocket middleware alongside ScrcpyConnection.
- Handles `ACTION.PROBE_DEVICE` WebSocket connections.
- On connection:
  1. Runs scrcpy-server with `list_encoders=true` arg (v3.x key=value format) to discover video/audio encoders. Parses stdout for encoder names.
  2. Runs `adb shell wm size` + `adb shell wm density` to get display dimensions and density.
  3. Sends a single JSON message: `{ displays: DisplayInfo[], videoEncoders: string[], audioEncoders: string[] }`.
  4. Closes the WebSocket.
- Lightweight: no TCP tunnel, no video stream, no reverse tunnel. Just ADB shell commands.

**New common action:**
- Add `PROBE_DEVICE = 'probe'` to `src/common/Action.ts`.

**New client utility: `src/app/client/DeviceProbeClient.ts`**
- Simple function: opens WebSocket to `?action=probe&udid=...`, receives JSON, closes.
- Returns `Promise<ProbeResult>`.
- Used by ConfigureScrcpy.

### ConfigureScrcpy Changes

- Remove `StreamReceiverScrcpy` import and field.
- Replace `createStreamReceiver()` with `DeviceProbeClient.probe(params)`.
- `onEncoders` / `onDisplayInfo` handlers become a single `onProbeResult(result)` handler.
- Add codec selection UI:
  - Video codec dropdown: H.264 / H.265 / AV1 (filtered by probe's `videoEncoders`)
  - Audio codec dropdown: Opus / AAC / FLAC / Raw (filtered by probe's `audioEncoders`)
  - These selections feed into ScrcpyOptions when the stream launches.
- Connection status: "Probing..." → "Ready" / "Probe failed".

### Deleted Files

- `src/app/client/StreamReceiver.ts`
- `src/app/googDevice/client/StreamReceiverScrcpy.ts`

### Kept

- `ManagerClient.ts` — still used by DeviceTracker for the multiplexed device list WebSocket.

---

## SP3-3: H.265/AV1 Video Codecs

### Goal

Decode H.265 (HEVC) and AV1 video streams alongside H.264 using WebCodecs VideoDecoder.

### Server Side

**ScrcpyOptions.ts:**
- Expand `videoCodec` type: `'h264' | 'h265' | 'av1'`.
- `serializeOptions()` emits `video_codec=h265` or `video_codec=av1` when selected.
- Default remains `h264`.

**ScrcpyConnection.ts / FrameReader.ts:**
- No changes. Frame forwarding is codec-agnostic — raw PTS + data bytes.

### Browser Side

**WebCodecsPlayer.ts:**
- Add codec detection in `pushVideoFrame()` when `isConfig` is true:
  - **H.264**: Config contains SPS NAL (type 7, `byte & 0x1f === 7`). Existing path.
  - **H.265**: Config contains VPS NAL (type 32, `(byte >> 1) & 0x3f === 32`). New path.
  - **AV1**: Config contains OBU Sequence Header (OBU type 1, `(byte >> 3) & 0xf === 1`). New path.
- Store detected codec type to route subsequent frames correctly.
- H.265/AV1 keyframes do NOT need config prepended (unlike H.264 which needs SPS/PPS before each keyframe) — scrcpy sends config inline.

**New file: `src/app/player/h265-utils.ts`**
- Parse HEVC VPS + SPS NAL units.
- Extract: general_profile_idc, general_tier_flag, general_level_idc, pic_width, pic_height.
- Build codec string: `hev1.{profile}.{compatibility}.{tier}{level}.{constraints}`.
- HEVC SPS parsing is more complex than H.264 (profile_tier_level structure, sub-layer ordering) but well-documented.

**New file: `src/app/player/av1-utils.ts`**
- Parse OBU Sequence Header.
- Extract: seq_profile, seq_level_idx, bit_depth, max_frame_width, max_frame_height.
- Build codec string: `av01.{profile}.{level}{tier}.{bitDepth}`.
- OBU uses length-delimited framing (no Annex B start codes).

**Existing `h264-utils.ts`:** No changes.

**`findNaluOffset()`** becomes codec-aware:
- H.264: start code + `(byte & 0x1f)` for NAL type.
- H.265: start code + `((byte >> 1) & 0x3f)` for NAL type.
- AV1: no start codes — OBU type is `(first_byte >> 3) & 0xf`.

### ConfigureScrcpy Integration

- Video codec dropdown (added in SP3-2) passes the selection through URL params → ScrcpyOptions → scrcpy-server.
- Encoder dropdown filters to encoders matching the selected codec.

---

## SP3-4: AAC/FLAC/Raw Audio Codecs

### Goal

Support AAC, FLAC, and raw PCM audio decoding alongside Opus.

### Server Side

**ScrcpyOptions.ts:**
- Expand `audioCodec` type: `'opus' | 'aac' | 'flac' | 'raw'`.
- `serializeOptions()` emits `audio_codec=aac` etc.
- Default remains `opus`.

**ScrcpyConnection.ts / FrameReader.ts:**
- No changes. Audio forwarding is codec-agnostic.

### Browser Side

**AudioPlayer.ts:**
- Replace hardcoded `codec: 'opus'` with codec-aware configuration:
  - **Opus**: `codec: 'opus'`, sampleRate 48000, 2ch. Config packets skipped (self-contained). Existing behavior.
  - **AAC**: `codec: 'mp4a.40.2'` (AAC-LC). Config packet contains AudioSpecificConfig — parse it to extract sample rate and channel count, pass as `description` to `configure()`.
  - **FLAC**: `codec: 'flac'`. Config packet contains STREAMINFO metadata block — parse for sample rate, channels, bits per sample. Pass as `description`.
  - **Raw PCM**: No AudioDecoder. Raw S16LE samples go directly to PcmWorklet. Bypass the decoder path entirely.
- New method: `configureFromCodecId(codecId: number)` — maps ScrcpyCodec ID to WebCodecs codec string and config handling strategy.
- `pushFrame()` updated: for AAC/FLAC, config packets are processed (not skipped like Opus). For raw, samples are posted directly to worklet.

**StreamClientScrcpy.ts:**
- `onMetadata()` currently creates `AudioPlayer('opus')`. Change to pass the actual `meta.audioCodec` string → `AudioPlayer(meta.audioCodec)`.
- Constructor: `AudioPlayer` created after metadata arrives (not before), since codec isn't known until then.

**PcmWorklet.ts:** No changes — already receives decoded float32 PCM regardless of source.

### ConfigureScrcpy Integration

- Audio codec dropdown (added in SP3-2) passes selection through URL params → ScrcpyOptions → scrcpy-server.

---

## SP3-5: UHID Keyboard/Mouse

### Goal

Hardware-level keyboard and mouse input via scrcpy's UHID protocol (control message types 12/13/14). Toggled on/off from the stream toolbar.

### New Control Message Classes

All use `Uint8Array` + `BinaryWriter` (from SP3-1).

**`src/app/controlMessage/UhidCreateMessage.ts`** (type 12)
- Payload: `id` (uint16), `nameLength` (uint16), `name` (UTF-8 bytes), `reportDescriptorSize` (uint16), `reportDescriptor` (bytes).
- Static builders:
  - `createKeyboard(id: number)` — standard 8-byte keyboard HID report descriptor.
  - `createMouse(id: number)` — standard 4-byte mouse HID report descriptor (buttons, dx, dy, wheel).

**`src/app/controlMessage/UhidInputMessage.ts`** (type 13)
- Payload: `id` (uint16), `size` (uint16), `data` (bytes).
- Keyboard report: 8 bytes (modifier mask, reserved, 6 simultaneous keycodes).
- Mouse report: 4 bytes (button mask, dx int8, dy int8, wheel int8).

**`src/app/controlMessage/UhidDestroyMessage.ts`** (type 14)
- Payload: `id` (uint16).

### UhidManager

**`src/app/googDevice/UhidManager.ts`**
- Lifecycle: create on stream connect, destroy on disconnect.
- Sends `UhidCreateMessage.createKeyboard(1)` and `UhidCreateMessage.createMouse(2)` on init.
- Sends `UhidDestroyMessage` for both on teardown.
- Public API:
  - `sendKeyReport(modifier: number, keycodes: number[])` — builds 8-byte keyboard report.
  - `sendMouseReport(buttons: number, dx: number, dy: number, wheel: number)` — builds 4-byte mouse report.
- Owned by `StreamClientScrcpy`, which passes its `sendMessage()` callback.

### Input Handlers

**`src/app/googDevice/UhidKeyboardHandler.ts`**
- Listens to `keydown`/`keyup` DOM events on document.
- Maintains a set of currently pressed keys.
- Maps `KeyboardEvent.code` → USB HID usage code via lookup table.
- Builds modifier mask from Ctrl/Shift/Alt/Meta state.
- Sends keyboard report on every key state change.

**`src/app/googDevice/UhidMouseHandler.ts`**
- Listens to `mousemove`/`mousedown`/`mouseup`/`wheel` on the player canvas.
- Activates pointer lock (`canvas.requestPointerLock()`) for relative movement.
- Uses `movementX`/`movementY` for dx/dy.
- Maintains button state from mousedown/mouseup events.
- Sends mouse report on every pointer/button/wheel event.

**`src/app/googDevice/hid-usage-tables.ts`**
- `KeyboardEvent.code` → USB HID usage code mapping.
- Standard 104-key layout. ~120 entries covering US keyboard, arrows, modifiers, numpad, function keys.

### UI Toggle

- Add a UHID button to `GoogToolBox` (the right-side toolbar, next to existing power/volume/back/home buttons).
- Default state: off (existing touch + keycode input active).
- Toggle on: creates UhidManager, attaches UhidKeyboardHandler + UhidMouseHandler, disables existing touch handler, requests pointer lock.
- Toggle off: destroys UhidManager (sends destroy messages), detaches handlers, releases pointer lock, re-enables touch handler.
- Visual indicator: button highlighted when UHID is active.

### StreamClientScrcpy Integration

- New field: `uhidManager?: UhidManager`.
- New method: `toggleUhid(enabled: boolean)`.
- Called from GoogToolBox button click.

---

## File Summary

### New Files (SP3)
| File | Sub-project |
|------|-------------|
| `src/app/BinaryWriter.ts` | SP3-1 |
| `src/app/BinaryReader.ts` | SP3-1 |
| `src/app/pathUtils.ts` | SP3-1 |
| `src/server/DeviceProbe.ts` | SP3-2 |
| `src/app/client/DeviceProbeClient.ts` | SP3-2 |
| `src/app/player/h265-utils.ts` | SP3-3 |
| `src/app/player/av1-utils.ts` | SP3-3 |
| `src/app/controlMessage/UhidCreateMessage.ts` | SP3-5 |
| `src/app/controlMessage/UhidInputMessage.ts` | SP3-5 |
| `src/app/controlMessage/UhidDestroyMessage.ts` | SP3-5 |
| `src/app/googDevice/UhidManager.ts` | SP3-5 |
| `src/app/googDevice/UhidKeyboardHandler.ts` | SP3-5 |
| `src/app/googDevice/UhidMouseHandler.ts` | SP3-5 |
| `src/app/googDevice/hid-usage-tables.ts` | SP3-5 |

### Deleted Files
| File | Sub-project |
|------|-------------|
| `src/app/client/StreamReceiver.ts` | SP3-2 |
| `src/app/googDevice/client/StreamReceiverScrcpy.ts` | SP3-2 |

### Modified Files (key changes)
| File | Sub-project | Change |
|------|-------------|--------|
| `webpack/ws-scrcpy-web.common.ts` | SP3-1 | Remove ProvidePlugin Buffer, remove path fallback |
| `src/app/controlMessage/ControlMessage.ts` | SP3-1 | `toBuffer()` → `toUint8Array()` |
| All 5 control message classes | SP3-1 | Buffer → BinaryWriter |
| `src/app/googDevice/DeviceMessage.ts` | SP3-1 | Buffer → BinaryReader |
| `src/app/googDevice/client/FileListingClient.ts` | SP3-1 | path → pathUtils |
| `src/server/index.ts` | SP3-2 | Register DeviceProbe middleware |
| `src/common/Action.ts` | SP3-2 | Add PROBE_DEVICE |
| `src/app/googDevice/client/ConfigureScrcpy.ts` | SP3-2 | StreamReceiverScrcpy → DeviceProbeClient, add codec dropdowns |
| `src/server/ScrcpyOptions.ts` | SP3-3, SP3-4 | Expand codec type unions |
| `src/app/player/WebCodecsPlayer.ts` | SP3-3 | Codec detection, H.265/AV1 parser dispatch |
| `src/app/audio/AudioPlayer.ts` | SP3-4 | Multi-codec configure, raw PCM path |
| `src/app/googDevice/client/StreamClientScrcpy.ts` | SP3-4, SP3-5 | Dynamic AudioPlayer codec, UhidManager |
| `src/app/googDevice/toolbox/GoogToolBox.ts` | SP3-5 | UHID toggle button |
