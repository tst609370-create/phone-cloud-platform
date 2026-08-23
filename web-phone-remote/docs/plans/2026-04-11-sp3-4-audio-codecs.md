# SP3-4: AAC/FLAC/Raw Audio Codecs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support AAC, FLAC, and raw PCM audio decoding alongside Opus, with codec selection flowing from ConfigureScrcpy through to scrcpy-server.

**Architecture:** Expand ScrcpyOptions audioCodec type and wire the selection through URL params (same pattern as videoCodec in SP3-3). Update AudioPlayer to handle four codecs: Opus (existing, self-contained frames), AAC (needs AudioSpecificConfig from config packet), FLAC (needs STREAMINFO from config packet), and Raw PCM (bypasses AudioDecoder entirely, posts samples directly to PcmWorklet). Move AudioPlayer creation from hardcoded 'opus' to dynamic based on metadata.

**Tech Stack:** TypeScript, WebCodecs AudioDecoder, AudioWorklet

**Spec:** `docs/specs/2026-04-11-sp3-feature-additions.md` (SP3-4 section)

---

## File Map

### Modified Files
| File | Change |
|------|--------|
| `src/server/ScrcpyOptions.ts` | Expand `audioCodec` type to `'opus' \| 'aac' \| 'flac' \| 'raw'` |
| `src/server/ScrcpyConnection.ts` | Read `audioCodec` from query params in `buildOptions()` |
| `src/app/googDevice/client/StreamClientScrcpy.ts` | Pass `audioCodec` to WS URL; create AudioPlayer with actual codec from metadata instead of hardcoded 'opus'; start audio for all codecs not just opus |
| `src/app/audio/AudioPlayer.ts` | Multi-codec support: AAC/FLAC config handling, raw PCM bypass, dynamic sample rate |

---

## Task 1: Wire audioCodec through URL params

**Files:**
- Modify: `src/server/ScrcpyOptions.ts`
- Modify: `src/server/ScrcpyConnection.ts`
- Modify: `src/app/googDevice/client/StreamClientScrcpy.ts`

- [ ] **Step 1: Expand ScrcpyOptions audioCodec type**

In `src/server/ScrcpyOptions.ts`, change line 5:

```typescript
// Before:
    audioCodec?: 'opus';
// After:
    audioCodec?: 'opus' | 'aac' | 'flac' | 'raw';
```

- [ ] **Step 2: Read audioCodec from query params in ScrcpyConnection**

In `src/server/ScrcpyConnection.ts`, in `buildOptions()`, add after the videoCodec block:

```typescript
        const audioCodec = this.queryParams.get('audioCodec');
        if (audioCodec === 'aac' || audioCodec === 'flac' || audioCodec === 'raw') {
            options.audioCodec = audioCodec;
        }
```

- [ ] **Step 3: Pass audioCodec from StreamClientScrcpy to WS URL**

In `src/app/googDevice/client/StreamClientScrcpy.ts`, in `buildStreamUrl()`, after the videoCodec block, add:

```typescript
        const audioCodec = this.params.audioCodec;
        if (audioCodec && audioCodec !== 'opus') {
            url.searchParams.set('audioCodec', audioCodec);
        }
```

- [ ] **Step 4: Verify build**

Run: `npm run build:dev 2>&1 | tail -5`
Expected: `compiled successfully`

- [ ] **Step 5: Commit**

```bash
git add src/server/ScrcpyOptions.ts src/server/ScrcpyConnection.ts src/app/googDevice/client/StreamClientScrcpy.ts
git commit -m "feat(sp3-4): wire audioCodec selection through URL params to ScrcpyOptions"
```

---

## Task 2: Update AudioPlayer for multi-codec support

**Files:**
- Modify: `src/app/audio/AudioPlayer.ts`

This is the main task. The current AudioPlayer hardcodes Opus behavior:
- `codec: this.codec` (always 'opus')
- `sampleRate: 48000` (Opus-specific)
- Skips config packets (`if (isConfig) return`)
- All frames decoded as `type: 'key'`

Changes needed for each codec:

**Opus** (existing): `codec: 'opus'`, sampleRate 48000, 2ch. Config packets skipped. All frames are key frames.

**AAC**: `codec: 'mp4a.40.2'` (AAC-LC). Config packet contains AudioSpecificConfig — store it and pass as `description` to `configure()`. Sample rate and channels parsed from config. Frames are key frames (each AAC frame is independently decodable with config).

**FLAC**: `codec: 'flac'`. Config packet contains FLAC STREAMINFO metadata block. Pass as `description` to `configure()`. Sample rate parsed from config.

**Raw PCM**: No AudioDecoder at all. Raw S16LE samples from scrcpy go directly to PcmWorklet. Bypass the entire decoder pipeline. Convert S16LE int16 samples to Float32 before posting to worklet.

- [ ] **Step 1: Rewrite AudioPlayer**

Replace the entire `src/app/audio/AudioPlayer.ts` with:

```typescript
// src/app/audio/AudioPlayer.ts
import { PCM_WORKLET_NAME, PCM_WORKLET_SOURCE } from './PcmWorklet';

export class AudioPlayer {
    private audioContext?: AudioContext;
    private decoder?: AudioDecoder;
    private workletNode?: AudioWorkletNode;
    private gainNode?: GainNode;
    private started = false;
    private workletReady = false;
    private configData?: Uint8Array;

    constructor(private readonly codec: string) {}

    async start(): Promise<void> {
        if (this.started) return;
        this.started = true;

        this.audioContext = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });

        // Load worklet via Blob URL
        const blob = new Blob([PCM_WORKLET_SOURCE], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        await this.audioContext.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        this.workletNode = new AudioWorkletNode(this.audioContext, PCM_WORKLET_NAME, {
            outputChannelCount: [2],
        });
        this.gainNode = this.audioContext.createGain();
        this.workletNode.connect(this.gainNode);
        this.gainNode.connect(this.audioContext.destination);
        this.workletReady = true;

        // Raw PCM doesn't need a decoder
        if (this.codec === 'raw') return;

        // Configure audio decoder
        this.decoder = new AudioDecoder({
            output: (audioData: AudioData) => {
                this.postDecodedAudio(audioData);
            },
            error: (err: DOMException) => {
                console.error('[AudioPlayer] Decoder error:', err.message);
            },
        });

        this.configureDecoder();
    }

    private configureDecoder(): void {
        if (!this.decoder) return;

        const config: AudioDecoderConfig = {
            codec: this.webCodecsCodecString(),
            sampleRate: 48000,
            numberOfChannels: 2,
        };

        // AAC and FLAC need the config packet as description
        if ((this.codec === 'aac' || this.codec === 'flac') && this.configData) {
            config.description = this.configData;
        }

        // Opus is self-contained; configure immediately
        // AAC/FLAC configure after receiving config packet (reconfigureDecoder called from pushFrame)
        if (this.codec === 'opus' || this.configData) {
            this.decoder.configure(config);
        }
    }

    private webCodecsCodecString(): string {
        switch (this.codec) {
            case 'opus': return 'opus';
            case 'aac': return 'mp4a.40.2';
            case 'flac': return 'flac';
            default: return this.codec;
        }
    }

    private postDecodedAudio(audioData: AudioData): void {
        if (!this.workletReady) {
            audioData.close();
            return;
        }
        const numChannels = audioData.numberOfChannels;
        const numFrames = audioData.numberOfFrames;
        const channels: Float32Array[] = [];
        for (let ch = 0; ch < numChannels; ch++) {
            const channelData = new Float32Array(numFrames);
            audioData.copyTo(channelData, { planeIndex: ch, format: 'f32-planar' });
            channels.push(channelData);
        }
        audioData.close();
        this.workletNode!.port.postMessage(
            { channels, numFrames },
            channels.map((c) => c.buffer),
        );
    }

    pushFrame(data: Uint8Array, pts: bigint, isConfig: boolean): void {
        if (this.codec === 'raw') {
            this.pushRawPcm(data);
            return;
        }

        if (isConfig) {
            this.configData = new Uint8Array(data);
            // For AAC/FLAC, (re)configure decoder now that we have the config
            if (this.codec === 'aac' || this.codec === 'flac') {
                this.configureDecoder();
            }
            return;
        }

        if (!this.decoder || this.decoder.state !== 'configured') return;

        this.decoder.decode(
            new EncodedAudioChunk({
                type: 'key',
                timestamp: Number(pts),
                data,
            }),
        );
    }

    /** Raw PCM: convert S16LE samples to Float32 and post directly to worklet. */
    private pushRawPcm(data: Uint8Array): void {
        if (!this.workletReady) return;

        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const sampleCount = (data.byteLength / 2) | 0; // 16-bit samples
        const channelCount = 2;
        const framesPerChannel = (sampleCount / channelCount) | 0;

        const channels: Float32Array[] = [];
        for (let ch = 0; ch < channelCount; ch++) {
            channels.push(new Float32Array(framesPerChannel));
        }

        for (let i = 0; i < framesPerChannel; i++) {
            for (let ch = 0; ch < channelCount; ch++) {
                const sampleIndex = i * channelCount + ch;
                const int16 = view.getInt16(sampleIndex * 2, true); // little-endian
                channels[ch][i] = int16 / 32768;
            }
        }

        this.workletNode!.port.postMessage(
            { channels, numFrames: framesPerChannel },
            channels.map((c) => c.buffer),
        );
    }

    async resume(): Promise<void> {
        if (this.audioContext?.state === 'suspended') {
            await this.audioContext.resume();
        }
    }

    setVolume(volume: number): void {
        if (this.gainNode) {
            this.gainNode.gain.value = Math.max(0, Math.min(1, volume));
        }
    }

    stop(): void {
        if (this.decoder && this.decoder.state !== 'closed') {
            this.decoder.close();
        }
        this.workletNode?.disconnect();
        this.gainNode?.disconnect();
        this.audioContext?.close();
        this.started = false;
        this.workletReady = false;
        this.configData = undefined;
    }
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build:dev 2>&1 | tail -5`
Expected: `compiled successfully`

- [ ] **Step 3: Commit**

```bash
git add src/app/audio/AudioPlayer.ts
git commit -m "feat(sp3-4): multi-codec AudioPlayer with AAC, FLAC, and raw PCM support"
```

---

## Task 3: Update StreamClientScrcpy to use dynamic audio codec

**Files:**
- Modify: `src/app/googDevice/client/StreamClientScrcpy.ts`

Currently, AudioPlayer is created with hardcoded `'opus'` (line 269) and `onMetadata` only starts audio for opus (line 188). Change both to use the actual codec from metadata.

- [ ] **Step 1: Move AudioPlayer creation after metadata arrives**

The AudioPlayer needs to be created with the correct codec, which is only known after metadata arrives. Change the code to defer AudioPlayer creation.

In `startStream()`, replace the AudioPlayer creation block (around lines 268-276):

```typescript
// Before:
        // Resume audio on first user interaction (autoplay policy)
        this.audioPlayer = new AudioPlayer('opus');
        const resumeAudio = () => {
            this.audioPlayer?.resume();
            document.removeEventListener('click', resumeAudio);
            document.removeEventListener('keydown', resumeAudio);
        };
        document.addEventListener('click', resumeAudio, { once: true });
        document.addEventListener('keydown', resumeAudio, { once: true });

// After:
        // Audio setup deferred to onMetadata (codec not known until then)
        const resumeAudio = () => {
            this.audioPlayer?.resume();
            document.removeEventListener('click', resumeAudio);
            document.removeEventListener('keydown', resumeAudio);
        };
        document.addEventListener('click', resumeAudio, { once: true });
        document.addEventListener('keydown', resumeAudio, { once: true });
```

- [ ] **Step 2: Create AudioPlayer in onMetadata with actual codec**

Replace the onMetadata audio handling (around lines 188-192):

```typescript
// Before:
        if (meta.audioCodec === 'opus' && this.audioPlayer) {
            this.audioPlayer.start().catch((err) => {
                console.error(TAG, 'Failed to start audio:', err.message);
            });
        }

// After:
        if (meta.audioCodec !== 'disabled' && meta.audioCodec !== 'error') {
            this.audioPlayer = new AudioPlayer(meta.audioCodec);
            this.audioPlayer.start().catch((err) => {
                console.error(TAG, 'Failed to start audio:', err.message);
            });
        }
```

- [ ] **Step 3: Verify build**

Run: `npm run build:dev 2>&1 | tail -5`
Expected: `compiled successfully`

- [ ] **Step 4: Commit**

```bash
git add src/app/googDevice/client/StreamClientScrcpy.ts
git commit -m "refactor(sp3-4): create AudioPlayer with actual codec from metadata instead of hardcoded opus"
```

---

## Task 4: Smoke test

- [ ] **Step 1: Build and start server**

```bash
npm run build:dev && node dist/index.js
```

- [ ] **Step 2: Test Opus audio (default)**

Open device list, click WebCodecs. Verify:
- Video stream works
- Console shows `video=h264 audio=opus`
- Click somewhere on the page to resume AudioContext (autoplay policy)

- [ ] **Step 3: Test AAC via Configure stream**

1. Click "Configure stream"
2. Select "aac" in Audio codec dropdown
3. Click Open
4. Verify stream starts, console shows `audio=aac`

- [ ] **Step 4: Test FLAC via Configure stream**

1. Click "Configure stream"
2. Select "flac" in Audio codec dropdown
3. Click Open
4. Verify stream starts, console shows `audio=flac`

- [ ] **Step 5: Test Raw via Configure stream**

1. Click "Configure stream"
2. Select "raw" in Audio codec dropdown
3. Click Open
4. Verify stream starts, console shows `audio=raw`

Note: Audio quality varies by codec. The important thing is no crashes or errors. Audio playback in Playwright headless may not work (no audio device), so zero console errors is the success criterion.

- [ ] **Step 6: Verify server logs**

Check that `ScrcpyConnection` session logs show the correct codec.

- [ ] **Step 7: Commit any fixes**
