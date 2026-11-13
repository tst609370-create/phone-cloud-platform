/**
 * Keeps the browser's picture live when the network (frp relay, tunnel,
 * slow uplink) is slower than the encoder.
 *
 * `ws.send` never blocks: without this, frames pile up in buffers and the
 * picture falls further and further behind — touch feedback arrives seconds
 * late and never catches up. When the backlog passes `highWater` we stop
 * sending delta frames, wait until the backlog drains below `lowWater`, ask
 * the phone for a fresh keyframe, and resume on it. Config packets are never
 * dropped (the decoder needs them).
 *
 * The backlog is measured end to end when the browser acknowledges frames
 * (ChannelId.ACK): bytes sent minus bytes the browser confirmed, which also
 * counts what sits in frpc / QUIC / kernel buffers. `ws.bufferedAmount` only
 * sees Node's own queue and is the fallback for old cached pages.
 */
export type VideoFrameKind = 'config' | 'keyframe' | 'delta';

export interface BackpressureOptions {
    highWater?: number;
    lowWater?: number;
    /** Minimum gap between keyframe requests. */
    resetIntervalMs?: number;
    /** Audio is dropped only beyond this much backlog. */
    audioHighWater?: number;
}

export const DEFAULT_VIDEO_HIGH_WATER = 1024 * 1024;
export const DEFAULT_VIDEO_LOW_WATER = 256 * 1024;

/**
 * Thresholds for the end-to-end (acknowledged) backlog: about 0.45 s of video
 * at the encoder bitrate before skipping, resume below ~0.15 s. Floors keep a
 * single large keyframe plus one network round trip from tripping it.
 */
export function ackedThresholds(bitrate: number | undefined): { highWater: number; lowWater: number } {
    const bytesPerSec = (bitrate && bitrate > 0 ? bitrate : 4_000_000) / 8;
    return {
        highWater: Math.max(192 * 1024, Math.round(bytesPerSec * 0.45)),
        lowWater: Math.max(64 * 1024, Math.round(bytesPerSec * 0.15)),
    };
}

export class VideoBackpressure {
    private highWater: number;
    private lowWater: number;
    private readonly resetIntervalMs: number;
    private audioHighWater: number;
    private dropping = false;
    private lastResetAt = Number.NEGATIVE_INFINITY;
    public droppedFrames = 0;
    public droppedAudio = 0;
    /** Times the network fell behind (entered the dropping state). */
    public episodes = 0;

    constructor(opts: BackpressureOptions = {}) {
        this.highWater = opts.highWater ?? DEFAULT_VIDEO_HIGH_WATER;
        this.lowWater = opts.lowWater ?? DEFAULT_VIDEO_LOW_WATER;
        this.resetIntervalMs = opts.resetIntervalMs ?? 1000;
        this.audioHighWater = opts.audioHighWater ?? this.highWater * 2;
    }

    /** Switch thresholds (e.g. once the browser starts acknowledging frames). */
    public setThresholds(highWater: number, lowWater: number): void {
        this.highWater = highWater;
        this.lowWater = lowWater;
        this.audioHighWater = highWater * 2;
    }

    public get isDropping(): boolean {
        return this.dropping;
    }

    /**
     * Decide one video frame. `send` = forward it; `requestKeyframe` = ask the
     * device to reset the encoder (scrcpy control type 17) now.
     */
    public video(kind: VideoFrameKind, buffered: number, now: number): { send: boolean; requestKeyframe: boolean } {
        if (kind === 'config') return { send: true, requestKeyframe: false };
        if (this.dropping) {
            if (buffered <= this.lowWater) {
                if (kind === 'keyframe') {
                    this.dropping = false;
                    return { send: true, requestKeyframe: false };
                }
                this.droppedFrames++;
                return { send: false, requestKeyframe: this.takeReset(now) };
            }
            this.droppedFrames++;
            return { send: false, requestKeyframe: false };
        }
        if (buffered > this.highWater) {
            this.dropping = true;
            this.episodes++;
            this.droppedFrames++;
            return { send: false, requestKeyframe: false };
        }
        return { send: true, requestKeyframe: false };
    }

    /**
     * The backlog changed without a new frame (an ACK arrived). While skipping
     * on a static screen no frame may come for a long time, so ask for the
     * keyframe as soon as the backlog has drained instead of waiting.
     */
    public drained(buffered: number, now: number): boolean {
        if (!this.dropping || buffered > this.lowWater) return false;
        return this.takeReset(now);
    }

    public audio(buffered: number): boolean {
        if (buffered > this.audioHighWater) {
            this.droppedAudio++;
            return false;
        }
        return true;
    }

    private takeReset(now: number): boolean {
        if (now - this.lastResetAt < this.resetIntervalMs) return false;
        this.lastResetAt = now;
        return true;
    }
}

/** scrcpy control message TYPE_RESET_VIDEO: makes the encoder emit a keyframe. */
export const RESET_VIDEO_MESSAGE = Buffer.from([17]);

/**
 * Server-side accounting for one stream: bytes sent vs. acknowledged, the
 * round trip through the video queue, and delivered throughput.
 */
export class StreamNetMeter {
    public sentBytes = 0;
    public ackedBytes = 0;
    public ackSeen = false;
    public rttMs = -1;
    private lastAckedAtTick = 0;
    private lastTickAt = 0;
    public goodputKbps = 0;
    /** Delivered rate measured while the network was behind (link capacity). */
    public capacityKbps = 0;

    public get inflight(): number {
        return Math.max(0, this.sentBytes - this.ackedBytes);
    }

    public onSent(bytes: number): void {
        this.sentBytes += bytes;
    }

    /** Browser ACK: total bytes it received, plus the echoed STATS clock (0 = none). */
    public onAck(received: number, echoT: number, now: number): void {
        this.ackSeen = true;
        if (received > this.ackedBytes && received <= this.sentBytes) this.ackedBytes = received;
        if (echoT > 0 && echoT <= now) this.rttMs = now - echoT;
    }

    /** Call about once a second; `behind` = the backlog is over the threshold. */
    public tick(now: number, behind: boolean): void {
        if (this.lastTickAt > 0) {
            const dt = (now - this.lastTickAt) / 1000;
            if (dt > 0) {
                this.goodputKbps = Math.round(((this.ackedBytes - this.lastAckedAtTick) * 8) / 1000 / dt);
                if (behind && this.goodputKbps > 0) {
                    this.capacityKbps = this.capacityKbps
                        ? Math.round(this.capacityKbps * 0.5 + this.goodputKbps * 0.5)
                        : this.goodputKbps;
                }
            }
        }
        this.lastTickAt = now;
        this.lastAckedAtTick = this.ackedBytes;
    }
}
