import { createRequire } from 'module';
import path from 'path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const PhoneAudio = require(path.resolve(__dirname, '../../../../public/phoneAudio.js'));

function frame(channel: number, config: boolean, pts: number, data: number[]): ArrayBuffer {
    const buf = new Uint8Array(13 + data.length);
    buf[0] = channel;
    const view = new DataView(buf.buffer);
    view.setUint32(1, (config ? 0x80000000 : 0) + Math.floor(pts / 2 ** 32));
    view.setUint32(5, pts >>> 0);
    view.setUint32(9, data.length);
    buf.set(data, 13);
    return buf.buffer;
}

describe('phoneAudio (snapshot-mode listener)', () => {
    it('parses audio frames and ignores video', () => {
        const msg = PhoneAudio.parseMessage(frame(1, false, 5000, [1, 2, 3, 4]));
        expect(msg).toMatchObject({ kind: 'audio', config: false, pts: 5000 });
        expect(Array.from(msg.data)).toEqual([1, 2, 3, 4]);
        expect(PhoneAudio.parseMessage(frame(1, true, 0, [9])).config).toBe(true);
        expect(PhoneAudio.parseMessage(frame(0, false, 0, [9]))).toBeNull();
    });

    it('parses metadata', () => {
        const text = new TextEncoder().encode(JSON.stringify({ audioCodec: 'error', audioReason: 'x' }));
        const buf = new Uint8Array(1 + text.length);
        buf[0] = 4;
        buf.set(text, 1);
        expect(PhoneAudio.parseMessage(buf.buffer)).toEqual({ kind: 'meta', meta: { audioCodec: 'error', audioReason: 'x' } });
    });

    it('splits interleaved s16le stereo', () => {
        const data = new Uint8Array(new Int16Array([16384, -16384, 0, 32767]).buffer);
        const [l, r] = PhoneAudio.s16ToFloat(data);
        expect(Array.from(l)).toEqual([0.5, 0]);
        expect(r[0]).toBe(-0.5);
        expect(r[1]).toBeCloseTo(1, 3);
    });

    it('asks for playback capture without dup once the device fell back to it', () => {
        (globalThis as any).location = { protocol: 'https:', host: 'h:1' };
        const url = new URL(PhoneAudio.streamUrl('abc', 'raw', 'playback'));
        expect(url.protocol).toBe('wss:');
        expect(url.searchParams.get('audioSource')).toBe('playback');
        expect(url.searchParams.get('audioDup')).toBe('false');
        expect(url.searchParams.get('audioCodec')).toBe('raw');
        expect(new URL(PhoneAudio.streamUrl('abc', 'opus', '')).searchParams.get('audioSource')).toBeNull();
    });
});
