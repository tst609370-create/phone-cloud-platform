/**
 * Keeps the browser's picture live when the network (frp relay, tunnel,
 * slow uplink) is slower than the encoder.
 *
 * `ws.send` never blocks: without this, frames pile up in the socket's send
 * buffer and the picture falls further and further behind — touch feedback
 * arrives seconds late and never catches up. When the backlog passes
 * `highWater` we stop sending delta frames, wait until the backlog drains
 * below `lowWater`, ask the phone for a fresh keyframe, and resume on it.
 * Config packets are never dropped (the decoder needs them).
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

export class VideoBackpressure {
    private readonly highWater: number;
    private readonly lowWater: number;
    private readonly resetIntervalMs: number;
    private readonly audioHighWater: number;
    private dropping = false;
    private lastResetAt = Number.NEGATIVE_INFINITY;
    public droppedFrames = 0;
    public droppedAudio = 0;

    constructor(opts: BackpressureOptions = {}) {
        this.highWater = opts.highWater ?? DEFAULT_VIDEO_HIGH_WATER;
        this.lowWater = opts.lowWater ?? DEFAULT_VIDEO_LOW_WATER;
        this.resetIntervalMs = opts.resetIntervalMs ?? 1000;
        this.audioHighWater = opts.audioHighWater ?? this.highWater * 2;
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
            this.droppedFrames++;
            return { send: false, requestKeyframe: false };
        }
        return { send: true, requestKeyframe: false };
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
