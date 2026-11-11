// src/app/audio/audioHealth.ts
// Pure watchdog for "I pressed 听声音 but hear nothing": turns what the player
// sees (frames arriving, their loudness, the AudioContext state) into one
// plain-language reason, or undefined when audio is actually playing.

export const AUDIO_NO_DATA_MS = 4000;
export const AUDIO_SILENT_MS = 6000;
/** Peak below this (float PCM, full scale 1.0) counts as digital silence. */
export const AUDIO_SILENT_PEAK = 0.0005;

export const REASON_GESTURE = '浏览器拦住了自动播放：点这里开声音';
export const REASON_NO_DATA = '手机没有送来声音数据（手机端音频采集没启动，重连或重插 USB 再试）';
/** Starts with SILENT_PREFIX: phones.js keys the automatic source switch on it. */
export const SILENT_PREFIX = '收到的全是静音';
export const REASON_SILENT = `${SILENT_PREFIX}：手机现在没在放声音，或手机媒体音量为 0`;

export interface AudioHealthState {
    startedAt: number;
    firstFrameAt?: number;
    lastLoudAt?: number;
    suspended: boolean;
    fatal?: string;
}

export function newAudioHealth(now: number): AudioHealthState {
    return { startedAt: now, suspended: false };
}

export function noteFrame(state: AudioHealthState, now: number, peak: number | undefined): void {
    if (state.firstFrameAt === undefined) state.firstFrameAt = now;
    if (peak !== undefined && peak > AUDIO_SILENT_PEAK) state.lastLoudAt = now;
}

export function audioProblem(state: AudioHealthState, now: number): string | undefined {
    if (state.fatal) return state.fatal;
    if (state.suspended) return REASON_GESTURE;
    if (state.firstFrameAt === undefined) {
        return now - state.startedAt >= AUDIO_NO_DATA_MS ? REASON_NO_DATA : undefined;
    }
    const loudSince = state.lastLoudAt ?? state.firstFrameAt;
    if (state.lastLoudAt === undefined && now - loudSince >= AUDIO_SILENT_MS) return REASON_SILENT;
    return undefined;
}

export function peakOf(channels: Float32Array[]): number {
    let peak = 0;
    for (const ch of channels) {
        for (let i = 0; i < ch.length; i++) {
            const v = Math.abs(ch[i]!);
            if (v > peak) peak = v;
        }
    }
    return peak;
}

/** Why this browser cannot decode the given scrcpy audio codec at all, if it cannot. */
export function browserAudioBlock(codec: string, env: {
    hasAudioContext: boolean;
    hasAudioDecoder: boolean;
    secure: boolean;
}): string | undefined {
    if (!env.hasAudioContext) return '这个浏览器不支持网页播放声音，请换新版 Chrome/Edge';
    if (codec === 'raw') return undefined;
    if (!env.hasAudioDecoder) {
        return env.secure
            ? '这个浏览器不能解码手机声音，请升级 Chrome/Edge'
            : '当前是 http 公网地址，浏览器禁用了声音解码；刷新页面会自动改用兼容模式';
    }
    return undefined;
}
