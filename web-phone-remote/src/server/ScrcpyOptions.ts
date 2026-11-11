// src/server/ScrcpyOptions.ts
export interface ScrcpyOptions {
    scid: string;
    videoCodec?: 'h264' | 'h265' | 'av1';
    audioCodec?: 'opus' | 'aac' | 'flac' | 'raw';
    audioSource?: 'output' | 'playback' | 'mic';
    audioDup?: boolean;
    maxSize?: number;
    videoBitRate?: number;
    maxFps?: number;
    audio?: boolean;
    control?: boolean;
    powerOn?: boolean;
    displayId?: number;
    sendDeviceMeta?: boolean;
    sendCodecMeta?: boolean;
    sendFrameMeta?: boolean;
    tunnelForward?: boolean;
    cleanup?: boolean;
    videoEncoder?: string;
    /**
     * scrcpy 4.x only aligns the video size to what the encoder reports (often
     * 2px), e.g. 486x1080. Some Qualcomm encoders (OnePlus/ColorOS) then emit
     * frames that decode to solid black. 16 is safe for every encoder/decoder.
     */
    minSizeAlignment?: 1 | 2 | 4 | 8 | 16;
}

const DEFAULTS: Omit<Required<ScrcpyOptions>, 'scid' | 'videoEncoder'> = {
    videoCodec: 'h264',
    audioCodec: 'opus',
    audioSource: 'output',
    audioDup: false,
    maxSize: 0,
    videoBitRate: 8000000,
    maxFps: 0,
    audio: true,
    control: true,
    powerOn: true,
    displayId: 0,
    sendDeviceMeta: true,
    sendCodecMeta: true,
    sendFrameMeta: true,
    tunnelForward: false,
    cleanup: true,
};

function toSnakeCase(key: string): string {
    return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export function serializeOptions(options: ScrcpyOptions): string[] {
    const args: string[] = [];
    for (const [key, defaultValue] of Object.entries(DEFAULTS)) {
        const value = (options as unknown as Record<string, unknown>)[key];
        if (value !== undefined && value !== defaultValue) {
            args.push(`${toSnakeCase(key)}=${value}`);
        }
    }
    args.push(`min_size_alignment=${options.minSizeAlignment ?? 16}`);
    // scid is always emitted
    args.push(`scid=${options.scid}`);
    if (options.videoEncoder) {
        args.push(`video_encoder=${options.videoEncoder}`);
    }
    return args;
}
