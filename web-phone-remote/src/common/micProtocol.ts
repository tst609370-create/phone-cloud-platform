/**
 * Virtual-mic wire protocol shared by the browser, the Node hub, the on-device
 * shell injector, and the LSPosed hook. Frame layout (all versions):
 *
 *   u8  type
 *   u32 length, big-endian
 *   payload[length]
 *
 * Payload endianness is little-endian so it matches PCM s16le.
 * Keep the Java copies in android/virtual-mic in sync with these numbers.
 */

export const MicFrameType = {
    HELLO: 1,
    FORMAT: 2,
    PCM: 3,
    STOP: 4,
    START: 5,
    READ: 16,
    DATA: 17,
    INACTIVE: 18,
} as const;

export type MicFrameTypeId = (typeof MicFrameType)[keyof typeof MicFrameType];

/** Device-side port the LSPosed hook connects to (adb reverse → host hub). */
export const MIC_DAEMON_PORT = 28256;
/** Device-side port the shell AudioPolicy injector listens on. */
export const MIC_SHELL_PORT = 28257;
export const MIC_PACKAGE = 'com.wsphone.virtualmic';
export const MIC_REMOTE_JAR = '/data/local/tmp/ws-virtual-mic.jar';
/** PCM the hub and the shell track exchange. Browser audio is resampled to this. */
export const MIC_PCM_RATE = 48000;
/** First Android release whose shell UID is worth attempting AudioPolicy injection on. */
export const ANDROID_SHELL_MIC_SDK = 33;

export const PCM16 = 2;
export const PCM8 = 3;
export const PCM_FLOAT = 4;

/** AudioRecord sources the hook may replace. 8 is REMOTE_SUBMIX (scrcpy playback capture). */
export const INJECTABLE_AUDIO_SOURCES = [0, 1, 5, 6, 7, 9, 10] as const;

export function isInjectableAudioSource(source: number): boolean {
    return (INJECTABLE_AUDIO_SOURCES as readonly number[]).includes(source);
}

export const MIC_MAX_PAYLOAD = 256 * 1024;

export interface MicFrame {
    type: number;
    payload: Uint8Array;
}

export type MicRouteName = 'lsposed' | 'shell';

/** Shown when another live controller already holds this phone's inject slot. */
export const MIC_BUSY_REASON = '这台手机的麦克风正被另一个控制端使用';

export interface MicCapability {
    supported: boolean;
    routes: MicRouteName[];
    sdkInt: number;
    rooted: boolean;
    bridgeInstalled: boolean;
    reason: string;
}

export interface MicStatus extends MicCapability {
    type: 'status';
    route: MicRouteName | 'none';
    active: boolean;
}

export function encodeMicFrame(type: number, payload: Uint8Array): Uint8Array {
    if (payload.byteLength > MIC_MAX_PAYLOAD) {
        throw new Error('mic frame too large');
    }
    const out = new Uint8Array(5 + payload.byteLength);
    const view = new DataView(out.buffer);
    view.setUint8(0, type);
    view.setUint32(1, payload.byteLength, false);
    out.set(payload, 5);
    return out;
}

export function encodeMicText(type: number, text: string): Uint8Array {
    return encodeMicFrame(type, new TextEncoder().encode(text));
}

export function encodeMicFormat(sampleRate: number, channels: number, bits: number): Uint8Array {
    const payload = new Uint8Array(8);
    const view = new DataView(payload.buffer);
    view.setUint32(0, sampleRate, true);
    view.setUint16(4, channels, true);
    view.setUint16(6, bits, true);
    return encodeMicFrame(MicFrameType.FORMAT, payload);
}

export function decodeMicFormat(payload: Uint8Array): { sampleRate: number; channels: number; bits: number } {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    return {
        sampleRate: view.getUint32(0, true),
        channels: view.getUint16(4, true),
        bits: view.getUint16(6, true),
    };
}

export function encodeMicRead(sampleRate: number, channels: number, encoding: number, byteCount: number): Uint8Array {
    const payload = new Uint8Array(12);
    const view = new DataView(payload.buffer);
    view.setUint32(0, sampleRate, true);
    view.setUint16(4, channels, true);
    view.setUint16(6, encoding, true);
    view.setUint32(8, byteCount, true);
    return encodeMicFrame(MicFrameType.READ, payload);
}

export function decodeMicRead(payload: Uint8Array): {
    sampleRate: number;
    channels: number;
    encoding: number;
    byteCount: number;
} {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    return {
        sampleRate: view.getUint32(0, true),
        channels: view.getUint16(4, true),
        encoding: view.getUint16(6, true),
        byteCount: view.getUint32(8, true),
    };
}

export class MicFrameDecoder {
    private buf = new Uint8Array(0);

    push(chunk: Uint8Array): MicFrame[] {
        this.buf = concatBytes(this.buf, chunk);
        const frames: MicFrame[] = [];
        while (this.buf.byteLength >= 5) {
            const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
            const type = view.getUint8(0);
            const len = view.getUint32(1, false);
            if (len > MIC_MAX_PAYLOAD) {
                this.buf = new Uint8Array(0);
                throw new Error('mic frame too large');
            }
            if (this.buf.byteLength < 5 + len) break;
            frames.push({ type, payload: new Uint8Array(this.buf.subarray(5, 5 + len)) });
            this.buf = new Uint8Array(this.buf.subarray(5 + len));
        }
        return frames;
    }
}

function concatBytes(a: Uint8Array, b: Uint8Array) {
    const out = new Uint8Array(a.byteLength + b.byteLength);
    out.set(a, 0);
    out.set(b, a.byteLength);
    return out;
}
