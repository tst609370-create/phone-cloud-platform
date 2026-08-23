# SP2 — Vanilla scrcpy v3.x Protocol

Design spec for Sub-Project 2 of ws-scrcpy-web. Replace the patched scrcpy-server v1.19-ws7 with vanilla Genymobile scrcpy-server v3.3.4, implementing the v3.x protocol in TypeScript with a Node.js TCP→WebSocket bridge and browser-side audio playback.

## Overview

The current architecture uses a custom-patched scrcpy-server that speaks WebSocket directly on the device. The Node.js server is a transparent WebSocket proxy. This requires re-patching Java code for every scrcpy update.

The new architecture uses the **vanilla, unmodified** Genymobile scrcpy-server. The Node.js server becomes a **protocol bridge** that reads 3 TCP sockets (tunneled via ADB) and multiplexes them onto a single WebSocket for the browser.

```
Current (v1.19-ws7):
  Browser ←WS→ Node.js ←WS/ADB→ Patched scrcpy-server
  (transparent proxy, single WS, server speaks WebSocket)

New (v3.3.4):
  Browser ←WS→ Node.js ←TCP/ADB→ Vanilla scrcpy-server
  (protocol bridge, single multiplexed WS, Node.js translates 3 TCP sockets)
```

## Multiplexed WebSocket Protocol

Single WebSocket connection between browser and Node.js server. Each message is prefixed with a 1-byte channel ID:

```
Byte 0:     Channel ID
Bytes 1+:   Payload
```

| Channel | Direction | Content |
|---------|-----------|---------|
| 0 | server→browser | Video frames |
| 1 | server→browser | Audio frames |
| 2 | browser→server | Control messages |
| 3 | server→browser | Device messages (clipboard, ack) |
| 4 | server→browser | Session metadata (JSON) |

Channel 4 carries a one-time JSON metadata message at session start:

```json
{
    "deviceName": "Pixel 9",
    "videoCodec": "h264",
    "screenWidth": 1080,
    "screenHeight": 2400,
    "audioCodec": "opus"
}
```

## scrcpy v3.x Frame Format

Both video and audio sockets use the same frame encapsulation:

```
Offset  Size  Field
0       8     PTS (uint64 BE) — presentation timestamp in microseconds
8       4     Size (uint32 BE) — byte length of following data
12      N     Frame data (codec bitstream)
```

**PTS special bits:**
- Bit 63 set (`0x8000000000000000`): **configuration packet** (SPS/PPS for H.264, not a displayable frame)
- Bit 62 set (`0x4000000000000000`): **keyframe** (actual PTS = value with bit 62 cleared)

## scrcpy v3.x Socket Architecture

Vanilla scrcpy-server opens 3 TCP sockets tunneled via ADB, always in this order:

1. **Video socket** (device→client): codec metadata (12 bytes) then encoded H.264 frames
2. **Audio socket** (device→client): codec status (4 bytes) then encoded Opus frames
3. **Control socket** (bidirectional): control messages (browser→device) + device messages (device→browser)

### Video Socket Initial Metadata

```
Bytes 0-63:   Device name (64 bytes, null-terminated UTF-8, padded)
Bytes 64-67:  Codec ID (uint32 BE) — 0x68323634 = "h264"
Bytes 68-71:  Width (uint32 BE)
Bytes 72-75:  Height (uint32 BE)
```

Then frames follow using the standard frame format above.

### Audio Socket Initial Metadata

```
Bytes 0-3:    Codec ID or status (uint32 BE)
              0x00000000 = audio disabled
              0x00000001 = audio error
              0x6F707573 = Opus (audio enabled)
```

If enabled, frames follow using the standard frame format.

### Control Socket

Bidirectional. No initial metadata. Client writes control messages, server writes device messages.

## Server-Side Components

### ScrcpyConnection

Core class managing a single scrcpy session lifecycle.

```typescript
class ScrcpyConnection {
    constructor(adbClient: AdbClient, serial: string)
    
    async connect(options: ScrcpyOptions): Promise<SessionMetadata>
    attachClient(ws: WebSocket): void
    async disconnect(): Promise<void>
}
```

**Connect sequence:**
1. Push `assets/scrcpy-server` to `/data/local/tmp/scrcpy-server.jar` via AdbClient
2. Generate random SCID (31-bit hex)
3. Start local TCP server on an ephemeral port
4. Set up ADB reverse tunnel: `adb reverse localabstract:scrcpy_<SCID> tcp:<localPort>`
5. Launch server: `adb shell CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server 3.3.4 <key=value args...>`
6. Accept 3 TCP connections (video, audio, control) in order
7. Parse initial metadata from video and audio sockets
8. Return `SessionMetadata` for the browser

**Forwarding loop:**
- Video/audio TCP sockets: read frames (PTS+size+data), prepend channel byte, send over WebSocket
- Control: receive from WebSocket (strip channel byte), write to control TCP socket
- Device messages: read from control TCP socket, prepend channel 3 byte, send over WebSocket

### ScrcpyOptions

Version-aware options builder. Serializes to `key=value` format.

```typescript
interface ScrcpyOptions {
    videoCodec: 'h264';
    audioCodec: 'opus';
    maxSize: number;              // default 0
    videoBitRate: number;         // default 8000000
    maxFps: number;               // default 0
    audio: boolean;               // default true
    control: boolean;             // default true
    displayId: number;            // default 0
    sendDeviceMeta: boolean;      // default true
    sendCodecMeta: boolean;       // default true
    sendFrameMeta: boolean;       // default true
    tunnelForward: boolean;       // default false (use reverse tunnel)
    scid: string;                 // random hex
}

function serializeOptions(options: ScrcpyOptions): string[]
// Returns: ["max_size=1080", "video_bit_rate=4000000", ...]
// Only emits non-default values. Converts camelCase to snake_case.
```

### FrameReader

Parses the scrcpy frame format from a TCP stream:

```typescript
class FrameReader {
    constructor(socket: net.Socket)
    
    onFrame(callback: (frame: ScrcpyFrame) => void): void
    onEnd(callback: () => void): void
}

interface ScrcpyFrame {
    type: 'config' | 'keyframe' | 'frame';
    pts: bigint;
    data: Buffer;
}
```

Reads the 12-byte header (PTS + size), then reads exactly `size` bytes of frame data. Decodes PTS flags (bit 63 = config, bit 62 = keyframe).

## Browser-Side Components

### ScrcpyDemuxer

Replaces `StreamReceiver` / `StreamReceiverScrcpy`. Routes multiplexed WebSocket messages by channel.

```typescript
class ScrcpyDemuxer {
    constructor(ws: WebSocket)
    
    onVideoFrame(cb: (data: Uint8Array, pts: bigint, isConfig: boolean, isKeyframe: boolean) => void): void
    onAudioFrame(cb: (data: Uint8Array, pts: bigint, isConfig: boolean) => void): void
    onDeviceMessage(cb: (type: number, data: Uint8Array) => void): void
    onMetadata(cb: (meta: SessionMetadata) => void): void
    
    sendControl(message: Uint8Array): void
}
```

Receives binary WebSocket messages, reads byte 0 as channel ID, dispatches payload to the appropriate callback. For video/audio channels, parses the 12-byte frame header before dispatching.

### WebCodecsPlayer Updates

Current behavior: receives raw NALUs, manually parses SPS to detect resolution and codec string, generates its own timestamps.

New behavior:
- Config packets (PTS bit 63) contain SPS/PPS — use these to configure `VideoDecoder` (still parse SPS for the `avc1.*` codec string via `h264-utils.ts`)
- Use PTS from frame headers for `EncodedVideoChunk.timestamp` (microseconds)
- Use keyframe flag for `EncodedVideoChunk.type` (`'key'` vs `'delta'`)
- Remove the manual frame buffering/IDR detection — the frame boundaries are now explicit from the size field

### AudioPlayer (new)

Decodes Opus audio and plays it via Web Audio API.

```typescript
class AudioPlayer {
    constructor(codec: 'opus')
    
    pushFrame(data: Uint8Array, pts: bigint, isConfig: boolean): void
    start(): void
    stop(): void
    setVolume(volume: number): void
}
```

**Implementation:**
1. Create `AudioContext` with `{ latencyHint: 'interactive' }`
2. Create `AudioDecoder` configured for Opus (`{ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 }`)
3. Decoder output callback receives `AudioData` objects
4. Feed decoded PCM samples to an `AudioWorkletNode` that plays them through a ring buffer
5. Handle browser autoplay policy: audio context starts in `suspended` state, resume on first user interaction

### PcmWorklet (new)

An `AudioWorkletProcessor` that:
1. Receives PCM samples via `port.postMessage()` (transferable `Float32Array`)
2. Stores in a ring buffer
3. `process()` method pulls from ring buffer to fill output frames
4. Handles underrun gracefully (output silence)

### Control Message Updates

**TouchControlMessage** (v2.0+ format, 32 bytes):
```
Byte 0:     type (2)
Byte 1:     action
Bytes 2-9:  pointerId (uint64 BE)
Bytes 10-13: x (uint32 BE)
Bytes 14-17: y (uint32 BE)
Bytes 18-19: screenWidth (uint16 BE)
Bytes 20-21: screenHeight (uint16 BE)
Bytes 22-23: pressure (uint16 BE, UnsignedFloat)
Bytes 24-27: actionButton (uint32 BE)     ← NEW (was not in v1.19)
Bytes 28-31: buttons (uint32 BE)
```

**ScrollControlMessage** (v1.25+ format, 21 bytes):
```
Byte 0:     type (3)
Bytes 1-4:  x (uint32 BE)
Bytes 5-8:  y (uint32 BE)
Bytes 9-10: screenWidth (uint16 BE)
Bytes 11-12: screenHeight (uint16 BE)
Bytes 13-14: hScroll (int16 BE, i16 fixed-point: value/16, clamped [-1,1], sc_float_to_i16fp)
Bytes 15-16: vScroll (int16 BE, i16 fixed-point: same encoding)
Bytes 17-20: buttons (uint32 BE)            ← NEW
Total: 21 bytes
```

**SetClipboard** (v1.21+ format):
```
Byte 0:     type (9)
Bytes 1-8:  sequence (uint64 BE)            ← NEW
Byte 9:     paste flag (uint8)              ← NEW
Bytes 10-13: text length (uint32 BE)
Bytes 14+:  text (UTF-8)
```

**New control message types (implement serializers):**
- UHidCreate (12): `type + id(u16) + dataLen(u16) + data`
- UHidInput (13): `type + id(u16) + dataLen(u16) + data`
- UHidDestroy (14): `type + id(u16)`
- OpenHardKeyboardSettings (15): `type` only
- StartApp (16): `type + nameLen(u8) + name`
- ResetVideo (17): `type` only

**Device message types (from control socket, server→client):**
- Clipboard (0): `type + length(u32) + text`
- AckClipboard (1): `type + sequence(u64)`
- UHidOutput (2): `type + id(u16) + dataLen(u16) + data`

## scrcpy-server Binary

Bundle vanilla Genymobile v3.3.4 `scrcpy-server` in `assets/scrcpy-server`. Download from the v3.3.4 GitHub release assets.

Update `THIRD-PARTY-NOTICES.md` to note the specific version bundled.

Replace `assets/scrcpy-server.jar` (old v1.19 patched) with `assets/scrcpy-server` (new v3.3.4 vanilla).

## ADB Tunnel Setup

Use **reverse tunnel** mode (default, most reliable):

```
adb -s <serial> reverse localabstract:scrcpy_<SCID> tcp:<localPort>
```

The Node.js server starts a TCP server on `localPort`. When scrcpy-server starts on the device, it connects to `localabstract:scrcpy_<SCID>`, which ADB forwards to our TCP server. We accept 3 connections in order (video, audio, control).

**Fallback:** If reverse fails (some ADB-over-WiFi scenarios), fall back to forward tunnel:
```
adb -s <serial> forward tcp:<localPort> localabstract:scrcpy_<SCID>
```
Then connect to `localhost:<localPort>`. First connection gets a dummy `0x00` byte to discard.

## New Files

| File | Purpose |
|------|---------|
| `src/server/ScrcpyConnection.ts` | TCP↔WS bridge, 3-socket management, session lifecycle |
| `src/server/ScrcpyOptions.ts` | Version-aware options builder + key=value serializer |
| `src/server/FrameReader.ts` | Parse scrcpy frame format (PTS+size+data) from TCP |
| `src/app/ScrcpyDemuxer.ts` | Browser channel demuxer (replaces StreamReceiver) |
| `src/app/audio/AudioPlayer.ts` | WebCodecs AudioDecoder + Web Audio playback |
| `src/app/audio/PcmWorklet.ts` | AudioWorklet for ring-buffered PCM playback |
| `src/common/ChannelId.ts` | Channel ID constants |
| `src/common/ScrcpyCodec.ts` | Codec ID constants (H264, Opus, etc.) |
| `assets/scrcpy-server` | Vanilla Genymobile v3.3.4 binary |

## Modified Files

| File | Change |
|------|--------|
| `src/common/Constants.ts` | Version=3.3.4, remove old args, update server process name |
| `src/app/player/WebCodecsPlayer.ts` | Use PTS/config/keyframe from headers, remove manual frame buffering |
| `src/app/controlMessage/TouchControlMessage.ts` | Add actionButton field (28→32 bytes) |
| `src/app/controlMessage/ScrollControlMessage.ts` | Add buttons field, SignedFloat encoding |
| `src/app/controlMessage/CommandControlMessage.ts` | Update SetClipboard with sequence/paste |
| `src/app/googDevice/client/StreamClientScrcpy.ts` | Use ScrcpyDemuxer, add AudioPlayer, update control flow |
| `src/app/googDevice/DeviceMessage.ts` | Add AckClipboard type (1) |
| `src/app/VideoSettings.ts` | Update to key=value options format |
| `src/server/goog-device/ScrcpyServer.ts` | New launch command, key=value args, vanilla server |
| `src/server/goog-device/Device.ts` | Simplify — no WS server PID tracking |
| `src/server/index.ts` | Wire ScrcpyConnection instead of WebSocket proxy |
| `THIRD-PARTY-NOTICES.md` | Update scrcpy version reference |

## Deleted Files

| File | Reason |
|------|--------|
| `src/server/mw/WebsocketProxy.ts` | Replaced by ScrcpyConnection |
| `src/server/goog-device/mw/WebsocketProxyOverAdb.ts` | Replaced by ScrcpyConnection |
| `src/app/client/StreamReceiver.ts` | Replaced by ScrcpyDemuxer |
| `src/app/googDevice/client/StreamReceiverScrcpy.ts` | Replaced by ScrcpyDemuxer |
| `src/server/goog-device/ServerVersion.ts` | Old version compat, only v3.3.4+ now |
| `assets/scrcpy-server.jar` | Replaced by vanilla v3.3.4 binary |

## Testing

- **Build:** `npm run build` succeeds
- **Smoke test:** Connect Android device, verify video streams, verify audio plays, verify touch/keyboard control works
- **Codec metadata:** Verify VideoDecoder receives correct config packets and codec string
- **Audio latency:** Verify audio is within ~200ms of video (acceptable for screen mirroring)
- **Tunnel fallback:** Test forward tunnel mode if reverse fails

## What SP2 Does NOT Change

- AdbClient.ts — still CLI-based, no changes
- File manager (FileListing, FilePush) — uses ADB directly, not scrcpy
- Shell client (ShellClient + node-pty) — independent of scrcpy
- Player base classes (BasePlayer, BaseCanvasBasedPlayer) — unchanged
- UI toolbox components — unchanged
- Biome/webpack/build config — unchanged
- Buffer usage in existing code — deferred to SP3
