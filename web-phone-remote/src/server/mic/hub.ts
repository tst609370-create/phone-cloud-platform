import net from 'net';
import {
    decodeMicRead,
    encodeMicFrame,
    MIC_PCM_RATE,
    MicFrameDecoder,
    MicFrameType,
    PCM_FLOAT,
    PCM8,
    PCM16,
} from '../../common/micProtocol';
import { resampleToLength } from './resample';

export function bytesPerSample(encoding: number): number {
    if (encoding === PCM8) return 1;
    if (encoding === PCM_FLOAT) return 4;
    return 2;
}

export function readDurationMs(sampleRate: number, channels: number, encoding: number, byteCount: number): number {
    const bpf = bytesPerSample(encoding) * Math.max(1, channels);
    if (bpf <= 0 || sampleRate <= 0 || byteCount <= 0) return 0;
    const frames = byteCount / bpf;
    return Math.min(2000, Math.max(0, Math.round((frames / sampleRate) * 1000)));
}

/**
 * Render `mono48k` (already the newest samples) into the exact buffer an
 * AudioRecord.read asked for. Short input becomes silence-padded audio.
 */
export function renderMicPayload(
    mono48k: Int16Array,
    _sampleRate: number,
    channels: number,
    encoding: number,
    byteCount: number,
): Uint8Array {
    const ch = Math.max(1, channels || 1);
    const bps = bytesPerSample(encoding);
    const bpf = bps * ch;
    const frames = bpf > 0 ? Math.floor(byteCount / bpf) : 0;
    const out = new Uint8Array(frames * bpf);
    if (frames === 0) return out;
    const mono = resampleToLength(mono48k, frames);
    const view = new DataView(out.buffer);
    for (let i = 0; i < frames; i++) {
        const sample = mono[i] ?? 0;
        for (let c = 0; c < ch; c++) {
            const index = i * ch + c;
            if (encoding === PCM8) {
                const unsigned = Math.max(0, Math.min(255, Math.round(sample / 256 + 128)));
                out[index] = unsigned;
            } else if (encoding === PCM_FLOAT) {
                view.setFloat32(index * 4, sample / 32768, true);
            } else {
                view.setInt16(index * 2, sample, true);
            }
        }
    }
    return out;
}

/**
 * One-second ring of mono s16le at {@link MIC_PCM_RATE}. Consumers always
 * read the newest tail so a slow app cannot add latency for the others.
 */
export class PcmRing {
    private readonly data: Int16Array;
    private writePos = 0;

    constructor(samples = MIC_PCM_RATE) {
        this.data = new Int16Array(samples);
    }

    push(samples: Int16Array): void {
        for (let i = 0; i < samples.length; i++) {
            this.data[this.writePos % this.data.length] = samples[i] ?? 0;
            this.writePos++;
        }
    }

    get written(): number {
        return this.writePos;
    }

    tail(count: number): Int16Array {
        const n = Math.max(0, Math.min(count, this.writePos, this.data.length));
        const out = new Int16Array(n);
        const start = this.writePos - n;
        for (let i = 0; i < n; i++) {
            out[i] = this.data[(start + i) % this.data.length] ?? 0;
        }
        return out;
    }
}

/**
 * Host end of the LSPosed bridge. The phone hook connects through `adb reverse`
 * and pulls PCM with READ frames. While injection is inactive the hub answers
 * INACTIVE so the hook leaves the hardware microphone alone.
 */
export class MicHub {
    private readonly server = net.createServer((socket) => {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
        socket.on('error', () => {
            socket.destroy();
            this.sockets.delete(socket);
        });
        this.serve(socket);
    });
    private readonly sockets = new Set<net.Socket>();
    private readonly ring = new PcmRing();
    private active = false;
    private generation = 0;
    private waiters: Array<() => void> = [];
    private closed = false;

    setActive(active: boolean): void {
        if (this.active === active) return;
        this.active = active;
        this.generation++;
        this.wake();
    }

    get isActive(): boolean {
        return this.active;
    }

    writeMono48k(samples: Int16Array): void {
        if (samples.length === 0) return;
        this.ring.push(samples);
    }

    async listen(): Promise<number> {
        await new Promise<void>((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(0, '127.0.0.1', () => resolve());
        });
        const addr = this.server.address();
        if (!addr || typeof addr === 'string') {
            throw new Error('麦克风桥监听失败');
        }
        return addr.port;
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.active = false;
        this.generation++;
        this.wake();
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }

    private wake(): void {
        const waiters = this.waiters;
        this.waiters = [];
        for (const waiter of waiters) waiter();
    }

    private wait(ms: number): Promise<void> {
        if (ms <= 0) return Promise.resolve();
        return new Promise((resolve) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const finish = () => {
                if (timer) clearTimeout(timer);
                this.waiters = this.waiters.filter((item) => item !== finish);
                resolve();
            };
            timer = setTimeout(finish, ms);
            this.waiters.push(finish);
        });
    }

    private serve(socket: net.Socket): void {
        const decoder = new MicFrameDecoder();
        let chain: Promise<void> = Promise.resolve();
        socket.on('data', (chunk: Buffer) => {
            let frames: ReturnType<MicFrameDecoder['push']>;
            try {
                frames = decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
            } catch {
                socket.destroy();
                return;
            }
            for (const frame of frames) {
                chain = chain
                    .then(() => this.handle(socket, frame.type, frame.payload))
                    .catch(() => {
                        socket.destroy();
                    });
            }
        });
    }

    private async handle(socket: net.Socket, type: number, payload: Uint8Array): Promise<void> {
        if (this.closed) return;
        if (type === MicFrameType.PCM && payload.byteLength >= 2) {
            const samples = new Int16Array(payload.byteLength / 2);
            const view = new DataView(
                payload.buffer,
                payload.byteOffset,
                payload.byteLength - (payload.byteLength % 2),
            );
            for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
            this.writeMono48k(samples);
            return;
        }
        if (type === MicFrameType.START) {
            this.setActive(true);
            return;
        }
        if (type === MicFrameType.STOP) {
            this.setActive(false);
            return;
        }
        if (type !== MicFrameType.READ) return;
        const req = decodeMicRead(payload);
        if (!this.active) {
            socket.write(Buffer.from(encodeMicFrame(MicFrameType.INACTIVE, new Uint8Array(0))));
            return;
        }
        const gen = this.generation;
        const ms = readDurationMs(req.sampleRate, req.channels, req.encoding, req.byteCount);
        await this.wait(ms);
        if (!this.active || gen !== this.generation) {
            socket.write(Buffer.from(encodeMicFrame(MicFrameType.INACTIVE, new Uint8Array(0))));
            return;
        }
        const bps = bytesPerSample(req.encoding);
        const frames = bps > 0 ? Math.floor(req.byteCount / (bps * Math.max(1, req.channels || 1))) : 0;
        const need = Math.max(1, Math.round((frames * MIC_PCM_RATE) / Math.max(1, req.sampleRate)));
        const tail = this.ring.written > 0 ? this.ring.tail(need) : new Int16Array(0);
        const body = renderMicPayload(tail, req.sampleRate, req.channels, req.encoding || PCM16, req.byteCount);
        socket.write(Buffer.from(encodeMicFrame(MicFrameType.DATA, body)));
    }
}
