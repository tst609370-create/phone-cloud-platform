# SP3-3: H.265/AV1 Video Codecs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support H.265 (HEVC) and AV1 video decoding alongside H.264, with codec selection flowing from ConfigureScrcpy through to the scrcpy-server.

**Architecture:** Expand ScrcpyOptions to accept the full codec set and wire the selection through URL params. Add two new parser modules (h265-utils, av1-utils) that extract codec strings and dimensions from their respective config packets. Update WebCodecsPlayer to auto-detect the codec from the first config packet and dispatch to the appropriate parser. The server-side FrameReader and ScrcpyConnection are already codec-agnostic — they forward raw frames.

**Tech Stack:** TypeScript, WebCodecs VideoDecoder, Exp-Golomb bitstream parsing, AV1 OBU parsing

**Spec:** `docs/specs/2026-04-11-sp3-feature-additions.md` (SP3-3 section)

---

## File Map

### New Files
| File | Responsibility |
|------|---------------|
| `src/app/player/h265-utils.ts` | HEVC SPS parser: extracts codec string (`hev1.X.Y.ZNN`) and dimensions |
| `src/app/player/av1-utils.ts` | AV1 OBU Sequence Header parser: extracts codec string (`av01.P.LLT.DD`) and dimensions |

### Modified Files
| File | Change |
|------|--------|
| `src/server/ScrcpyOptions.ts` | Expand `videoCodec` type to `'h264' \| 'h265' \| 'av1'` |
| `src/server/ScrcpyConnection.ts` | Read `videoCodec` from query params in `buildOptions()` |
| `src/app/googDevice/client/StreamClientScrcpy.ts` | Pass `videoCodec` from params to WS URL in `buildStreamUrl()` |
| `src/app/player/h264-utils.ts` | Export `BitStream` class so h265-utils can reuse it |
| `src/app/player/WebCodecsPlayer.ts` | Multi-codec detection, dispatch to H.264/H.265/AV1 parsers |

---

## Task 1: Wire video codec through URL params

**Files:**
- Modify: `src/server/ScrcpyOptions.ts`
- Modify: `src/server/ScrcpyConnection.ts`
- Modify: `src/app/googDevice/client/StreamClientScrcpy.ts`

- [ ] **Step 1: Expand ScrcpyOptions videoCodec type**

In `src/server/ScrcpyOptions.ts`, change line 4:

```typescript
// Before:
    videoCodec?: 'h264';
// After:
    videoCodec?: 'h264' | 'h265' | 'av1';
```

- [ ] **Step 2: Read videoCodec from query params in ScrcpyConnection**

In `src/server/ScrcpyConnection.ts`, add to `buildOptions()` after the displayId block (around line 83):

```typescript
        const videoCodec = this.queryParams.get('videoCodec');
        if (videoCodec === 'h265' || videoCodec === 'av1') {
            options.videoCodec = videoCodec;
        }
```

- [ ] **Step 3: Pass videoCodec from StreamClientScrcpy to WS URL**

In `src/app/googDevice/client/StreamClientScrcpy.ts`, in `buildStreamUrl()` after the existing video settings block (around line 145), add:

```typescript
        // Pass codec selections from ConfigureScrcpy
        const videoCodec = this.params.videoCodec;
        if (videoCodec && videoCodec !== 'h264') {
            url.searchParams.set('videoCodec', videoCodec);
        }
```

- [ ] **Step 4: Verify build**

Run: `npm run build:dev 2>&1 | tail -5`
Expected: `compiled successfully`

- [ ] **Step 5: Commit**

```bash
git add src/server/ScrcpyOptions.ts src/server/ScrcpyConnection.ts src/app/googDevice/client/StreamClientScrcpy.ts
git commit -m "feat(sp3-3): wire videoCodec selection through URL params to ScrcpyOptions"
```

---

## Task 2: Export BitStream from h264-utils

**Files:**
- Modify: `src/app/player/h264-utils.ts`

The BitStream class (Exp-Golomb reader) is currently private in h264-utils.ts. H.265 parsing uses the same Exp-Golomb coding, so export it for reuse.

- [ ] **Step 1: Export BitStream**

In `src/app/player/h264-utils.ts`, change line 20 from:

```typescript
class BitStream {
```

To:

```typescript
export class BitStream {
```

No other changes needed.

- [ ] **Step 2: Verify build**

Run: `npm run build:dev 2>&1 | tail -5`
Expected: `compiled successfully`

- [ ] **Step 3: Commit**

```bash
git add src/app/player/h264-utils.ts
git commit -m "refactor(sp3-3): export BitStream from h264-utils for reuse by h265-utils"
```

---

## Task 3: Create h265-utils (HEVC SPS parser)

**Files:**
- Create: `src/app/player/h265-utils.ts`

The HEVC codec string format is: `hev1.{profile}.{compat_flags_hex}.{tier}{level}`

Example: `hev1.1.6.L93` (Main profile, tier=Main, level=3.1)

The parser needs to:
1. Find the SPS NAL unit (type 33) in the Annex B stream
2. Parse profile_tier_level to get profile_idc, general_profile_compatibility_flags, tier_flag, level_idc
3. Parse pic_width_in_luma_samples and pic_height_in_luma_samples
4. Build the codec string

HEVC NAL type is extracted as `(byte >> 1) & 0x3f` (different from H.264's `byte & 0x1f`). The NAL header is 2 bytes (not 1 like H.264).

- [ ] **Step 1: Create h265-utils.ts**

```typescript
// src/app/player/h265-utils.ts
import { BitStream } from './h264-utils';

export const HEVC_NAL_TYPE = {
    VPS: 32,
    SPS: 33,
    PPS: 34,
} as const;

/** Extract HEVC NAL unit type from first byte after start code. */
export function hevcNalType(byte: number): number {
    return (byte >> 1) & 0x3f;
}

export interface HevcCodecInfo {
    codec: string;
    width: number;
    height: number;
}

/**
 * Parse HEVC SPS NAL to extract codec string and dimensions.
 * Input: Uint8Array starting at the first byte of the SPS NAL unit (after start code).
 */
export function parseHevcSPS(data: Uint8Array): HevcCodecInfo {
    const bs = new BitStream(data);

    // NAL unit header: 2 bytes (forbidden_zero_bit, nal_unit_type, nuh_layer_id, nuh_temporal_id_plus1)
    bs.skipBits(16);

    // sps_video_parameter_set_id (4 bits)
    bs.skipBits(4);
    // sps_max_sub_layers_minus1 (3 bits)
    const maxSubLayersMinus1 = bs.readBits(3);
    // sps_temporal_id_nesting_flag (1 bit)
    bs.skipBits(1);

    // profile_tier_level(1, maxSubLayersMinus1)
    const { profileIdc, tierFlag, levelIdc, compatFlags } = parseProfileTierLevel(bs, maxSubLayersMinus1);

    // sps_seq_parameter_set_id
    bs.skipUEG();

    // chroma_format_idc
    const chromaFormatIdc = bs.readUEG();
    if (chromaFormatIdc === 3) {
        bs.skipBits(1); // separate_colour_plane_flag
    }

    // pic_width_in_luma_samples, pic_height_in_luma_samples
    const width = bs.readUEG();
    const height = bs.readUEG();

    // Build codec string: hev1.{profile}.{compat_hex}.{tier}{level}
    const tier = tierFlag ? 'H' : 'L';
    const codec = `hev1.${profileIdc}.${compatFlags.toString(16).toUpperCase()}.${tier}${levelIdc}`;

    return { codec, width, height };
}

function parseProfileTierLevel(
    bs: BitStream,
    maxSubLayersMinus1: number,
): { profileIdc: number; tierFlag: number; levelIdc: number; compatFlags: number } {
    // general_profile_space (2 bits)
    bs.skipBits(2);
    // general_tier_flag (1 bit)
    const tierFlag = bs.readBits(1);
    // general_profile_idc (5 bits)
    const profileIdc = bs.readBits(5);
    // general_profile_compatibility_flags (32 bits)
    let compatFlags = 0;
    for (let i = 0; i < 32; i++) {
        compatFlags = (compatFlags | (bs.readBits(1) << (31 - i))) >>> 0;
    }
    // general_progressive_source_flag .. general_reserved_zero_43bits (48 bits)
    bs.skipBits(48);
    // general_level_idc (8 bits)
    const levelIdc = bs.readBits(8);

    // sub_layer profiles (skip)
    if (maxSubLayersMinus1 > 0) {
        const subLayerProfilePresentFlag: boolean[] = [];
        const subLayerLevelPresentFlag: boolean[] = [];
        for (let i = 0; i < maxSubLayersMinus1; i++) {
            subLayerProfilePresentFlag.push(bs.readBoolean());
            subLayerLevelPresentFlag.push(bs.readBoolean());
        }
        // padding for remaining 2-bit pairs up to 8
        if (maxSubLayersMinus1 < 8) {
            bs.skipBits(2 * (8 - maxSubLayersMinus1));
        }
        for (let i = 0; i < maxSubLayersMinus1; i++) {
            if (subLayerProfilePresentFlag[i]) {
                bs.skipBits(88); // sub_layer profile data
            }
            if (subLayerLevelPresentFlag[i]) {
                bs.skipBits(8); // sub_layer_level_idc
            }
        }
    }

    return { profileIdc, tierFlag, levelIdc, compatFlags };
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build:dev 2>&1 | tail -5`
Expected: `compiled successfully`

- [ ] **Step 3: Commit**

```bash
git add src/app/player/h265-utils.ts
git commit -m "feat(sp3-3): add HEVC SPS parser for H.265 codec string extraction"
```

---

## Task 4: Create av1-utils (AV1 OBU Sequence Header parser)

**Files:**
- Create: `src/app/player/av1-utils.ts`

The AV1 codec string format is: `av01.{profile}.{level:02d}{tier}.{bitDepth:02d}`

Example: `av01.0.04M.08` (Main profile, level 2.0, Main tier, 8-bit)

AV1 uses OBU (Open Bitstream Unit) format — NOT Annex B start codes. The OBU header byte has the type in bits 4-7: `(byte >> 3) & 0xf`. OBU type 1 = Sequence Header.

- [ ] **Step 1: Create av1-utils.ts**

```typescript
// src/app/player/av1-utils.ts

export const OBU_TYPE = {
    SEQUENCE_HEADER: 1,
    TEMPORAL_DELIMITER: 2,
    FRAME_HEADER: 3,
    FRAME: 6,
} as const;

/** Extract OBU type from header byte. */
export function obuType(byte: number): number {
    return (byte >> 3) & 0xf;
}

export interface Av1CodecInfo {
    codec: string;
    width: number;
    height: number;
}

/**
 * Parse AV1 OBU Sequence Header to extract codec string and dimensions.
 * Input: Uint8Array containing the full OBU (including header).
 */
export function parseAv1SequenceHeader(data: Uint8Array): Av1CodecInfo {
    let pos = 0;

    // OBU header
    const headerByte = data[pos++];
    const hasExtension = (headerByte >> 2) & 1;
    const hasSizeField = (headerByte >> 1) & 1;

    if (hasExtension) pos++; // skip extension byte

    if (hasSizeField) {
        // Read leb128 size (skip it — we parse inline)
        readLeb128(data, pos);
        pos = readLeb128(data, pos).newPos;
    }

    // Sequence Header OBU payload
    const reader = new Av1BitReader(data, pos);

    // seq_profile (3 bits)
    const seqProfile = reader.f(3);
    // still_picture (1 bit)
    reader.f(1);
    // reduced_still_picture_header (1 bit)
    const reducedStillPicture = reader.f(1);

    let seqLevelIdx = 0;
    let seqTier = 0;
    let bitDepth = 8;

    if (reducedStillPicture) {
        seqLevelIdx = reader.f(5);
    } else {
        // timing_info_present_flag
        const timingInfoPresent = reader.f(1);
        if (timingInfoPresent) {
            // timing_info()
            reader.f(32); // num_units_in_display_tick
            reader.f(32); // time_scale
            const equalPictureInterval = reader.f(1);
            if (equalPictureInterval) {
                reader.uvlc(); // num_ticks_per_picture_minus_1
            }
            // decoder_model_info_present_flag
            const decoderModelInfoPresent = reader.f(1);
            if (decoderModelInfoPresent) {
                reader.f(5); // buffer_delay_length_minus_1
                reader.f(32); // num_units_in_decoding_tick
                reader.f(5); // buffer_removal_time_length_minus_1
                reader.f(5); // frame_presentation_time_length_minus_1
            }
        }
        // initial_display_delay_present_flag
        reader.f(1);
        // operating_points_cnt_minus_1
        const opCnt = reader.f(5) + 1;
        for (let i = 0; i < opCnt; i++) {
            reader.f(12); // operating_point_idc
            const level = reader.f(5); // seq_level_idx
            if (i === 0) seqLevelIdx = level;
            if (level > 7) {
                const tier = reader.f(1); // seq_tier
                if (i === 0) seqTier = tier;
            }
        }
    }

    // frame_width_bits_minus_1 (4 bits), frame_height_bits_minus_1 (4 bits)
    const widthBits = reader.f(4) + 1;
    const heightBits = reader.f(4) + 1;
    // max_frame_width_minus_1, max_frame_height_minus_1
    const width = reader.f(widthBits) + 1;
    const height = reader.f(heightBits) + 1;

    // Skip to color_config for bit_depth
    if (!reducedStillPicture) {
        // frame_id_numbers_present_flag
        const frameIdNumbersPresent = reader.f(1);
        if (frameIdNumbersPresent) {
            reader.f(4); // delta_frame_id_length_minus_2
            reader.f(3); // additional_frame_id_length_minus_1
        }
    }

    // use_128x128_superblock, enable_filter_intra, enable_intra_edge_filter
    reader.f(1);
    reader.f(1);
    reader.f(1);

    if (!reducedStillPicture) {
        // enable_interintra_compound, enable_masked_compound, enable_warped_motion,
        // enable_dual_filter, enable_order_hint
        reader.f(1);
        reader.f(1);
        reader.f(1);
        reader.f(1);
        const enableOrderHint = reader.f(1);
        if (enableOrderHint) {
            reader.f(1); // enable_jnt_comp
            reader.f(1); // enable_ref_frame_mvs
        }
        // seq_choose_screen_content_tools
        const seqForceScreenContentTools = reader.f(1) ? 2 : reader.f(1);
        if (seqForceScreenContentTools > 0) {
            // seq_choose_integer_mv
            if (!reader.f(1)) {
                reader.f(1); // seq_force_integer_mv
            }
        }
        if (enableOrderHint) {
            reader.f(3); // order_hint_bits_minus_1
        }
    }

    // enable_superres, enable_cdef, enable_restoration
    reader.f(1);
    reader.f(1);
    reader.f(1);

    // color_config()
    const highBitDepth = reader.f(1);
    if (seqProfile === 2 && highBitDepth) {
        const twelveBit = reader.f(1);
        bitDepth = twelveBit ? 12 : 10;
    } else {
        bitDepth = highBitDepth ? 10 : 8;
    }

    // Build codec string: av01.{profile}.{level:02d}{tier}.{bitDepth:02d}
    const tierChar = seqTier ? 'H' : 'M';
    const levelStr = seqLevelIdx.toString().padStart(2, '0');
    const bdStr = bitDepth.toString().padStart(2, '0');
    const codec = `av01.${seqProfile}.${levelStr}${tierChar}.${bdStr}`;

    return { codec, width, height };
}

function readLeb128(data: Uint8Array, pos: number): { value: number; newPos: number } {
    let value = 0;
    let i = 0;
    let byte: number;
    do {
        byte = data[pos++];
        value |= (byte & 0x7f) << (i * 7);
        i++;
    } while (byte & 0x80 && i < 8);
    return { value, newPos: pos };
}

class Av1BitReader {
    private bitPos: number;
    private readonly data: Uint8Array;

    constructor(data: Uint8Array, byteOffset: number) {
        this.data = data;
        this.bitPos = byteOffset * 8;
    }

    f(n: number): number {
        let value = 0;
        for (let i = 0; i < n; i++) {
            const byteIdx = (this.bitPos >> 3);
            const bitIdx = 7 - (this.bitPos & 7);
            value = (value << 1) | ((this.data[byteIdx] >> bitIdx) & 1);
            this.bitPos++;
        }
        return value;
    }

    uvlc(): number {
        let leadingZeros = 0;
        while (this.f(1) === 0) leadingZeros++;
        if (leadingZeros >= 32) return (1 << 32) - 1;
        return (1 << leadingZeros) - 1 + this.f(leadingZeros);
    }
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build:dev 2>&1 | tail -5`
Expected: `compiled successfully`

- [ ] **Step 3: Commit**

```bash
git add src/app/player/av1-utils.ts
git commit -m "feat(sp3-3): add AV1 OBU Sequence Header parser for codec string extraction"
```

---

## Task 5: Update WebCodecsPlayer for multi-codec support

**Files:**
- Modify: `src/app/player/WebCodecsPlayer.ts`

This is the main integration task. WebCodecsPlayer currently assumes H.264 exclusively. Update it to auto-detect the codec from the config packet and dispatch to the appropriate parser.

- [ ] **Step 1: Add imports**

```typescript
// Add after existing h264-utils import:
import { hevcNalType, HEVC_NAL_TYPE, parseHevcSPS } from './h265-utils';
import { obuType, OBU_TYPE, parseAv1SequenceHeader } from './av1-utils';
```

- [ ] **Step 2: Add codec type tracking**

Add a field to track detected codec:

```typescript
    private detectedCodec: 'h264' | 'h265' | 'av1' | null = null;
```

- [ ] **Step 3: Replace pushVideoFrame config handling**

Replace the `if (isConfig)` block (lines 93-109) with codec-detecting logic:

```typescript
        if (isConfig) {
            const result = this.parseConfig(data);
            if (result) {
                this.scaleCanvas(result.width, result.height);
                if (this.decoder.state === 'configured') {
                    this.decoder.flush().catch(() => {});
                }
                this.decoder.configure({
                    codec: result.codec,
                    optimizeForLatency: true,
                } as VideoDecoderConfig);
            }
            this.configData = new Uint8Array(data);
            return;
        }
```

- [ ] **Step 4: Add parseConfig method**

This method auto-detects the codec and dispatches to the appropriate parser:

```typescript
    private parseConfig(data: Uint8Array): { codec: string; width: number; height: number } | null {
        // Try Annex B start code detection (H.264/H.265)
        const naluOffset = this.findStartCode(data);
        if (naluOffset >= 0) {
            const firstByte = data[naluOffset];
            // H.264: NAL type is (byte & 0x1f), SPS = 7
            const h264Type = firstByte & 0x1f;
            // H.265: NAL type is ((byte >> 1) & 0x3f), VPS = 32, SPS = 33
            const h265Type = hevcNalType(firstByte);

            if (h265Type === HEVC_NAL_TYPE.VPS || h265Type === HEVC_NAL_TYPE.SPS) {
                this.detectedCodec = 'h265';
                // Find SPS NAL (type 33) for parsing
                const spsOffset = this.findHevcNalu(data, HEVC_NAL_TYPE.SPS);
                if (spsOffset >= 0) {
                    return parseHevcSPS(data.subarray(spsOffset));
                }
            } else if (h264Type === 7) {
                this.detectedCodec = 'h264';
                const spsOffset = this.findNaluOffset(data, 7);
                if (spsOffset >= 0) {
                    return WebCodecsPlayer.parseSPSCodecString(data.subarray(spsOffset));
                }
            }
            return null;
        }

        // No Annex B start code — try AV1 OBU
        if (data.length > 0 && obuType(data[0]) === OBU_TYPE.SEQUENCE_HEADER) {
            this.detectedCodec = 'av1';
            return parseAv1SequenceHeader(data);
        }

        return null;
    }
```

- [ ] **Step 5: Add helper methods for start code and HEVC NAL finding**

```typescript
    /** Find first Annex B start code, return offset of byte after it. -1 if not found. */
    private findStartCode(data: Uint8Array): number {
        for (let i = 0; i < data.length - 4; i++) {
            if (data[i] === 0 && data[i + 1] === 0) {
                if (data[i + 2] === 1) return i + 3;
                if (data[i + 2] === 0 && data[i + 3] === 1) return i + 4;
            }
        }
        return -1;
    }

    /** Find HEVC NAL unit by type. Returns offset of first byte of NAL unit. */
    private findHevcNalu(data: Uint8Array, nalType: number): number {
        for (let i = 0; i < data.length - 4; i++) {
            if (data[i] === 0 && data[i + 1] === 0) {
                let offset: number;
                if (data[i + 2] === 1) {
                    offset = i + 3;
                } else if (data[i + 2] === 0 && data[i + 3] === 1) {
                    offset = i + 4;
                } else {
                    continue;
                }
                if (offset < data.length && hevcNalType(data[offset]) === nalType) {
                    return offset;
                }
            }
        }
        return -1;
    }
```

- [ ] **Step 6: Update keyframe handling for H.265/AV1**

The current code prepends configData to H.264 keyframes (the decoder needs SPS/PPS before each keyframe). For H.265, the same logic applies (VPS/SPS/PPS needed). For AV1, config prepending is NOT needed — scrcpy sends config inline.

Update the keyframe block (lines 114-132):

```typescript
        if (isKeyframe && this.configData) {
            if (!this.receivedFirstFrame) {
                this.receivedFirstFrame = true;
            }

            if (this.detectedCodec === 'av1') {
                // AV1: no config prepending needed
                this.decoder.decode(
                    new EncodedVideoChunk({
                        type: 'key',
                        timestamp: Number(pts),
                        data,
                    }),
                );
            } else {
                // H.264/H.265: prepend config (SPS/PPS or VPS/SPS/PPS)
                const fullData = new Uint8Array(this.configData.length + data.length);
                fullData.set(this.configData);
                fullData.set(data, this.configData.length);
                this.decoder.decode(
                    new EncodedVideoChunk({
                        type: 'key',
                        timestamp: Number(pts),
                        data: fullData,
                    }),
                );
            }
            return;
        }
```

- [ ] **Step 7: Reset detectedCodec on stop**

In the `stop()` method, add:

```typescript
        this.detectedCodec = null;
```

- [ ] **Step 8: Verify build**

Run: `npm run build:dev 2>&1 | tail -10`
Expected: `compiled successfully`

- [ ] **Step 9: Commit**

```bash
git add src/app/player/WebCodecsPlayer.ts
git commit -m "feat(sp3-3): add multi-codec detection and H.265/AV1 decoding to WebCodecsPlayer"
```

---

## Task 6: Smoke test

- [ ] **Step 1: Build and start server**

```bash
npm run build:dev && node dist/index.js
```

- [ ] **Step 2: Test H.264 stream (default)**

Open `http://localhost:8000/`, click WebCodecs link. Verify video stream works as before (H.264 is the default codec).

- [ ] **Step 3: Test H.265 via Configure stream**

1. Click "Configure stream"
2. Select "h265" in the Video codec dropdown
3. Click Open
4. Verify video stream starts (the Google TV Streamer has `c2.mtk.hevc.encoder` so H.265 should work)

Check browser console for: `[StreamClientScrcpy] Connected: ... video=h265`

- [ ] **Step 4: Test AV1 via Configure stream**

1. Click "Configure stream"
2. Select "av1" in the Video codec dropdown
3. Click Open
4. Verify video stream starts (the Google TV Streamer has `c2.android.av1.encoder`)

Check browser console for: `[StreamClientScrcpy] Connected: ... video=av1`

- [ ] **Step 5: Verify server logs**

```bash
cat /tmp/ws-scrcpy-server.log
```

Should show the session metadata with the correct codec for each test.

- [ ] **Step 6: Commit any fixes**

If smoke testing reveals parser bugs, fix them and commit.
