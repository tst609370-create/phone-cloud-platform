import type { DeviceKind } from '../server/goog-device/deviceKind';

export type AudioSource = 'playback' | 'output' | 'mic';

/**
 * Whether audio streaming should default to ON for a given device kind.
 *
 * Returns `true` for all kinds. We default to `--audio-source=playback` with
 * `--audio-dup`, which keeps device audio playing normally while also streaming
 * it to the browser (requires Android 13+ / SDK 33+; the server forces audio
 * off below that threshold — see ScrcpyConnection.start()).
 *
 * The `kind` parameter is preserved for forward-compat in case a future device
 * class needs a different default.
 */
export function audioEnabledDefault(_kind: DeviceKind | undefined): boolean {
    return true;
}

/**
 * Default audio-capture source. Matches scrcpy's own default (`output`) —
 * captures the whole audio output, which silences device playback during the
 * session. `playback` + `--audio-dup` is an opt-in in `ConfigureScrcpy` for
 * users who want device audio to keep playing while they mirror (Android 13+).
 */
export const DEFAULT_AUDIO_SOURCE: AudioSource = 'output';

/** scrcpy can capture audio starting at Android 11 / SDK 30. Older devices can't. */
export function audioCaptureSupported(sdkInt: number): boolean {
    return Number.isFinite(sdkInt) && sdkInt >= 30;
}

/** Why phone playback cannot be sent to the browser, when the user asked for it. */
export function playbackAudioBlockReason(sdkInt: number): string | undefined {
    if (sdkInt > 0 && sdkInt < 30) {
        return `Android API ${sdkInt} 低于 11，不能把手机播放声送到浏览器`;
    }
    return undefined;
}

/** `--audio-dup` (keeps device audio playing during capture) requires Android 13+. */
export function audioDupSupported(sdkInt: number): boolean {
    return Number.isFinite(sdkInt) && sdkInt >= 33;
}

/**
 * Default audio source for a given SDK. Always `output` today — that's
 * scrcpy's own default and it works on every audio-capable SDK (30+).
 * Accepts `sdkInt` for forward-compat in case we ever want to re-tier
 * (e.g. a future SDK that only supports a particular source).
 */
export function defaultAudioSourceForSdk(_sdkInt: number): AudioSource {
    return DEFAULT_AUDIO_SOURCE;
}
