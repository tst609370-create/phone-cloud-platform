import { describe, expect, it } from 'vitest';
import { PACKET_FLAG_SESSION, PTS_FLAG_CONFIG, PTS_FLAG_KEYFRAME } from '../FrameReader';
import { SCRCPY_41_OPTION_KEYS, acceptScrcpy41Control } from '../scrcpy41';
import { serializeOptions } from '../ScrcpyOptions';
import { scrcpyOptionsFromQuery } from '../scrcpyOptionsFromQuery';

describe('serializeOptions — audio_source / audio_dup', () => {
    it('emits audio_source=playback + audio_dup=true when using playback with dup', () => {
        const args = serializeOptions({ scid: 'abc', audioSource: 'playback', audioDup: true });
        expect(args).toContain('audio_source=playback');
        expect(args).toContain('audio_dup=true');
    });

    it('emits audio_source=mic without audio_dup', () => {
        const args = serializeOptions({ scid: 'abc', audioSource: 'mic' });
        expect(args).toContain('audio_source=mic');
        expect(args.some((a) => a.startsWith('audio_dup'))).toBe(false);
    });

    it('omits audio_source when it matches scrcpy default (output)', () => {
        const args = serializeOptions({ scid: 'abc', audioSource: 'output' });
        expect(args.some((a) => a.startsWith('audio_source'))).toBe(false);
    });

    it('omits audio_dup when false (scrcpy default)', () => {
        const args = serializeOptions({ scid: 'abc', audioDup: false });
        expect(args.some((a) => a.startsWith('audio_dup'))).toBe(false);
    });
});

describe('serializeOptions — scid + base fields still work', () => {
    it('always emits scid last', () => {
        const args = serializeOptions({ scid: 'deadbeef' });
        expect(args[args.length - 1]).toBe('scid=deadbeef');
    });

    it('omits video_codec when it matches default (h264)', () => {
        const args = serializeOptions({ scid: 's', videoCodec: 'h264' });
        expect(args.some((a) => a.startsWith('video_codec'))).toBe(false);
    });

    it('emits video_codec when non-default (h265)', () => {
        const args = serializeOptions({ scid: 's', videoCodec: 'h265' });
        expect(args).toContain('video_codec=h265');
    });

    it('emits audio=false when disabled', () => {
        const args = serializeOptions({ scid: 's', audio: false });
        expect(args).toContain('audio=false');
    });

    it('emits power_on=false when automatic wake is disabled', () => {
        const args = serializeOptions({ scid: 's', powerOn: false });
        expect(args).toContain('power_on=false');
    });

    it('emits video_encoder flag when set (separate code path)', () => {
        const args = serializeOptions({ scid: 's', videoEncoder: 'c2.qti.hevc.encoder' });
        expect(args).toContain('video_encoder=c2.qti.hevc.encoder');
    });
});

describe('scrcpy 4.1 contract', () => {
    it('serializes the wall stream with option names 4.1 still parses', () => {
        const query = new URLSearchParams('audio=false&bitrate=800000&maxFps=30&maxSize=480');
        const args = serializeOptions(scrcpyOptionsFromQuery(query, '0a1b2c3d'));
        const keys = args.map((arg) => arg.slice(0, arg.indexOf('=')));
        for (const key of keys) {
            expect(SCRCPY_41_OPTION_KEYS).toContain(key);
        }
        expect(args).toContain('audio=false');
        expect(args).toContain('power_on=false');
        expect(args).toContain('video_bit_rate=800000');
        expect(args).toContain('scid=0a1b2c3d');
        expect(args.some((arg) => arg.startsWith('send_codec_meta'))).toBe(false);
    });

    it('keeps the v4 frame flags and does not forward extension control types', () => {
        expect(PACKET_FLAG_SESSION).toBe(1n << 63n);
        expect(PTS_FLAG_CONFIG).toBe(1n << 62n);
        expect(PTS_FLAG_KEYFRAME).toBe(1n << 61n);
        expect(acceptScrcpy41Control(Uint8Array.of(2, 0))).toBe(true);
        expect(acceptScrcpy41Control(Uint8Array.of(10, 1))).toBe(true);
        expect(acceptScrcpy41Control(Uint8Array.of(101))).toBe(false);
        expect(acceptScrcpy41Control(Uint8Array.of(102))).toBe(false);
    });
});
