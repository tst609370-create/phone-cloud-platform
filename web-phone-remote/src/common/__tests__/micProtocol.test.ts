import { describe, expect, it } from 'vitest';
import {
    decodeMicFormat,
    decodeMicRead,
    encodeMicFormat,
    encodeMicFrame,
    encodeMicRead,
    encodeMicText,
    INJECTABLE_AUDIO_SOURCES,
    isInjectableAudioSource,
    MIC_DAEMON_PORT,
    MIC_SHELL_PORT,
    MicFrameDecoder,
    MicFrameType,
} from '../micProtocol';

describe('mic frame codec', () => {
    it('round-trips a payload split across chunks', () => {
        const frame = encodeMicText(MicFrameType.HELLO, 'CONSUME');
        const decoder = new MicFrameDecoder();
        expect(decoder.push(frame.slice(0, 3))).toEqual([]);
        const rest = decoder.push(frame.slice(3));
        expect(rest).toHaveLength(1);
        expect(rest[0]?.type).toBe(MicFrameType.HELLO);
        expect(new TextDecoder().decode(rest[0]?.payload)).toBe('CONSUME');
    });

    it('round-trips format and read requests', () => {
        const format = new MicFrameDecoder().push(encodeMicFormat(48000, 1, 16))[0];
        expect(format?.type).toBe(MicFrameType.FORMAT);
        expect(decodeMicFormat(format?.payload ?? new Uint8Array())).toEqual({
            sampleRate: 48000,
            channels: 1,
            bits: 16,
        });
        const read = new MicFrameDecoder().push(encodeMicRead(16000, 1, 2, 640))[0];
        expect(decodeMicRead(read?.payload ?? new Uint8Array())).toEqual({
            sampleRate: 16000,
            channels: 1,
            encoding: 2,
            byteCount: 640,
        });
    });

    it('rejects an oversized length without throwing away the next socket', () => {
        const evil = new Uint8Array(5);
        const view = new DataView(evil.buffer);
        view.setUint8(0, MicFrameType.PCM);
        view.setUint32(1, 1024 * 1024, false);
        const decoder = new MicFrameDecoder();
        expect(() => decoder.push(evil)).toThrow(/too large/);
        const ok = decoder.push(encodeMicFrame(MicFrameType.STOP, new Uint8Array(0)));
        expect(ok[0]?.type).toBe(MicFrameType.STOP);
    });

    it('keeps the device ports stable', () => {
        expect(MIC_DAEMON_PORT).toBe(28256);
        expect(MIC_SHELL_PORT).toBe(28257);
    });
});

describe('injectable audio sources', () => {
    it('covers mic presets and never the scrcpy submix', () => {
        expect(isInjectableAudioSource(1)).toBe(true);
        expect(isInjectableAudioSource(7)).toBe(true);
        expect(isInjectableAudioSource(8)).toBe(false);
        expect(INJECTABLE_AUDIO_SOURCES).not.toContain(8);
    });
});
