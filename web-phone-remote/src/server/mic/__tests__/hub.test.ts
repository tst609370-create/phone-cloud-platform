import net from 'net';
import { describe, expect, it } from 'vitest';
import { decodeMicRead, encodeMicRead, MicFrameDecoder, MicFrameType } from '../../../common/micProtocol';
import { MicHub, renderMicPayload } from '../hub';

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
        hub.writeMono48k(Int16Array.of(1000, 1000, 1000, 1000));
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
