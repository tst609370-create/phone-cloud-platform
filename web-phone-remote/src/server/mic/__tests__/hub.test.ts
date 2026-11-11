import net from 'net';
import { describe, expect, it } from 'vitest';
import { decodeMicRead, encodeMicRead, MicFrameDecoder, MicFrameType } from '../../../common/micProtocol';
import { MIC_JITTER_SAMPLES, MIC_MAX_LAG_SAMPLES, MicHub, MicReader, PcmRing, renderMicPayload } from '../hub';

describe('renderMicPayload', () => {
    it('expands mono s16 into stereo and pads silence when the ring is empty', () => {
        const silence = renderMicPayload(new Int16Array(0), 16000, 1, 2, 4);
        expect(Array.from(silence)).toEqual([0, 0, 0, 0]);
        const stereo = renderMicPayload(Int16Array.of(1000, 1000), 48000, 2, 2, 8);
        const view = new DataView(stereo.buffer);
        expect(view.getInt16(0, true)).toBe(1000);
        expect(view.getInt16(2, true)).toBe(1000);
        expect(view.getInt16(4, true)).toBe(1000);
        expect(view.getInt16(6, true)).toBe(1000);
    });
});

describe('renderMicPayload underrun', () => {
    it('pads a short read with trailing silence instead of stretching it', () => {
        const out = renderMicPayload(Int16Array.of(500, 500), 48000, 1, 2, 8);
        const view = new DataView(out.buffer);
        expect([0, 1, 2, 3].map((i) => view.getInt16(i * 2, true))).toEqual([500, 500, 0, 0]);
    });
});

describe('MicReader', () => {
    const ramp = (from: number, n: number) => Int16Array.from({ length: n }, (_, i) => (from + i) % 30000);

    it('hands out every sample once and never repeats when input stalls', () => {
        const ring = new PcmRing();
        const reader = new MicReader();
        ring.push(ramp(0, 960 + MIC_JITTER_SAMPLES));
        const got: number[] = [];
        for (let i = 0; i < 10; i++) got.push(...reader.take(ring, 960, 0, 1));
        // nothing new arrived after the first push: exactly what was written, in order, once
        expect(got).toEqual(Array.from(ramp(0, 960 + MIC_JITTER_SAMPLES)));
    });

    it('waits for a jitter cushion after an underrun', () => {
        const ring = new PcmRing();
        const reader = new MicReader();
        ring.push(ramp(0, 480));
        expect(reader.take(ring, 960, 0, 1).length).toBe(0);
        ring.push(ramp(480, 960 + MIC_JITTER_SAMPLES));
        expect(reader.take(ring, 960, 0, 1).length).toBe(960);
    });

    it('skips ahead when it falls too far behind', () => {
        const ring = new PcmRing();
        const reader = new MicReader();
        ring.push(ramp(0, 960 + MIC_JITTER_SAMPLES));
        reader.take(ring, 960, 0, 1);
        reader.take(ring, 960, 0, 1);
        reader.take(ring, 960, 0, 1);
        ring.push(ramp(5000, MIC_MAX_LAG_SAMPLES * 2));
        const out = reader.take(ring, 960, 0, 1);
        expect(out.length).toBe(960);
        // after the jump it plays from one read + jitter before the newest sample
        expect(out[0]).toBe(5000 + MIC_MAX_LAG_SAMPLES * 2 - 960 - MIC_JITTER_SAMPLES);
    });

    it('does not replay audio from before the current activation', () => {
        const ring = new PcmRing();
        const reader = new MicReader();
        ring.push(new Int16Array(4000).fill(7));
        const activeFrom = ring.written;
        expect(reader.take(ring, 960, activeFrom, 2).length).toBe(0);
        ring.push(new Int16Array(960 + MIC_JITTER_SAMPLES).fill(9));
        const out = reader.take(ring, 960, activeFrom, 2);
        expect(out.length).toBe(960);
        expect(Array.from(out).every((v) => v === 9)).toBe(true);
    });
});

describe('MicHub', () => {
    it('returns INACTIVE until injection is on, then the newest PCM', async () => {
        const hub = new MicHub();
        const port = await hub.listen();
        const socket = await connect(port);
        const decoder = new MicFrameDecoder();
        const frames = collect(socket, decoder);

        socket.write(Buffer.from(encodeMicRead(48000, 1, 2, 4)));
        const inactive = await frames.next();
        expect(inactive.type).toBe(MicFrameType.INACTIVE);

        hub.setActive(true);
        hub.writeMono48k(new Int16Array(4 + MIC_JITTER_SAMPLES).fill(1000));
        socket.write(Buffer.from(encodeMicRead(48000, 1, 2, 4)));
        const data = await frames.next();
        expect(data.type).toBe(MicFrameType.DATA);
        const view = new DataView(data.payload.buffer, data.payload.byteOffset, data.payload.byteLength);
        expect(view.getInt16(0, true)).toBe(1000);
        expect(decodeMicRead(encodeMicRead(1, 1, 2, 4).slice(5)).byteCount).toBe(4);

        socket.destroy();
        await hub.close();
    });
});

function connect(port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port }, () => resolve(socket));
        socket.once('error', reject);
    });
}

function collect(socket: net.Socket, decoder: MicFrameDecoder) {
    const pending: Array<(frame: { type: number; payload: Uint8Array }) => void> = [];
    const queued: Array<{ type: number; payload: Uint8Array }> = [];
    socket.on('data', (chunk: Buffer) => {
        for (const frame of decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))) {
            const waiter = pending.shift();
            if (waiter) waiter(frame);
            else queued.push(frame);
        }
    });
    return {
        next: () =>
            new Promise<{ type: number; payload: Uint8Array }>((resolve, reject) => {
                const existing = queued.shift();
                if (existing) {
                    resolve(existing);
                    return;
                }
                const timer = setTimeout(() => reject(new Error('hub frame timeout')), 2000);
                pending.push((frame) => {
                    clearTimeout(timer);
                    resolve(frame);
                });
            }),
    };
}
