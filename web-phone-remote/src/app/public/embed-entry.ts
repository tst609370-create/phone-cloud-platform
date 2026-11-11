/**
 * embed.html entry script. Parses URL params and calls WsScrcpy.startStream.
 * Built as a standalone IIFE bundle and shipped as embed.js.
 */

import type { StartStreamOptions, StreamHandle } from './types';

// Declare the UMD global that ws-scrcpy.umd.js installs on the window
// before embed.js runs. Using the global instead of importing ./startStream
// avoids re-bundling the entire stream client into embed.js.
declare global {
    interface Window {
        WsScrcpy?: {
            startStream: (container: HTMLElement, deviceId: string, options?: StartStreamOptions) => StreamHandle;
            version: string;
        };
    }
}

const CODECS = new Set(['h264', 'h265', 'av1']);
const DEVICE_KINDS = new Set(['phone', 'tablet', 'tv']);
const AUDIO_SOURCES = new Set(['playback', 'output', 'mic']);
const AUDIO_CODECS = new Set(['opus', 'aac', 'flac', 'raw']);

export function parseEmbedParams(params: URLSearchParams): {
    deviceId: string | null;
    options: StartStreamOptions;
} {
    const deviceId = params.get('device');
    const options: StartStreamOptions = {};

    const readStr = (key: keyof StartStreamOptions) => {
        const v = params.get(key as string);
        if (v) (options as Record<string, unknown>)[key] = v;
    };
    const readInt = (key: keyof StartStreamOptions) => {
        const v = params.get(key as string);
        if (!v) return;
        const n = parseInt(v, 10);
        if (!Number.isNaN(n)) (options as Record<string, unknown>)[key] = n;
    };
    const readBool = (key: keyof StartStreamOptions) => {
        const v = params.get(key as string);
        if (v === 'true') (options as Record<string, unknown>)[key] = true;
        else if (v === 'false') (options as Record<string, unknown>)[key] = false;
    };

    readStr('host');
    readStr('encoder');
    readStr('pathname');

    const codec = params.get('codec');
    if (codec && CODECS.has(codec)) options.codec = codec as StartStreamOptions['codec'];

    const deviceKind = params.get('deviceKind');
    if (deviceKind && DEVICE_KINDS.has(deviceKind)) {
        options.deviceKind = deviceKind as StartStreamOptions['deviceKind'];
    }

    const audioSource = params.get('audioSource');
    if (audioSource && AUDIO_SOURCES.has(audioSource)) {
        options.audioSource = audioSource as StartStreamOptions['audioSource'];
    }

    const audioCodec = params.get('audioCodec');
    if (audioCodec && AUDIO_CODECS.has(audioCodec)) {
        options.audioCodec = audioCodec as StartStreamOptions['audioCodec'];
    }

    readInt('port');
    readInt('bitrate');
    readInt('maxFps');
    readInt('maxSize');

    readBool('secure');
    readBool('audio');
    readBool('keyboard');

    return { deviceId: deviceId ?? null, options };
}

// Only run the bootstrap when this script is loaded by embed.html.
// embed.html sets <body data-embed-entry> as an explicit opt-in marker;
// tests and any other importer never set it, so bootstrap stays dormant.
function shouldBootstrap(): boolean {
    return typeof document !== 'undefined' && document.body?.hasAttribute('data-embed-entry') === true;
}

if (typeof document !== 'undefined' && document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => {
        if (shouldBootstrap()) bootstrap();
    });
} else if (shouldBootstrap()) {
    bootstrap();
}

function bootstrap(): void {
    const statusEl = document.getElementById('status');
    const show = (msg: string, isError = false) => {
        if (!statusEl) return;
        statusEl.textContent = msg;
        statusEl.classList.remove('hidden');
        statusEl.style.color = isError ? '#f06c75' : '#ddd';
    };
    const hide = () => statusEl?.classList.add('hidden');

    const { deviceId, options } = parseEmbedParams(new URLSearchParams(location.search));
    if (!deviceId) {
        show('missing required "device" param', true);
        return;
    }

    const audioNote = createAudioNote();
    options.onAudioStatus = (problem) => audioNote.set(problem);
    options.onConnect = (info) => {
        const failed = info.audio === 'disabled' || info.audio === 'error';
        audioNote.set(failed && info.audioReason ? `没有声音：${info.audioReason}` : undefined);
        if (info.audio === 'pending') {
            show(`connected \u00b7 ${info.codec} \u00b7 ${info.resolution} \u00b7 正在打开播放声`);
            return;
        }
        const audio = info.audio && info.audio !== 'disabled' ? ` \u00b7 audio ${info.audio}` : '';
        show(`connected \u00b7 ${info.codec} \u00b7 ${info.resolution}${audio}`);
        setTimeout(hide, 2000);
    };
    options.onDisconnect = (reason) => show(`disconnected${reason ? ` (${reason})` : ''}`, true);
    options.onError = (err) => show(`error: ${err.message}`, true);

    if (!window.WsScrcpy) {
        show('error: WsScrcpy library not loaded (expected ws-scrcpy.umd.js to run first)', true);
        return;
    }
    // Never sit on "connecting..." silently: say what to check.
    setTimeout(() => {
        if (statusEl && !statusEl.classList.contains('hidden') && /^connecting/i.test(statusEl.textContent || '')) {
            show('error: 视频 20 秒没连上。检查电脑上的服务和中转是否在线，或点刷新重连；手机浏览器请用 Chrome / Edge', true);
        }
    }, 20000);
    try {
        const handle = window.WsScrcpy.startStream(document.body, deviceId, options);
        window.addEventListener('message', (event) => {
            if (event.origin !== location.origin) return;
            if (event.data?.type === 'phone-display-power') {
                handle.setScreenPower(Boolean(event.data.on));
                return;
            }
            if (event.data?.type === 'phone-stream-profile') {
                const { bitrate, maxFps, maxSize } = event.data;
                if ([bitrate, maxFps, maxSize].every((value) => Number.isFinite(value) && value > 0)) {
                    handle.setVideoProfile({ bitrate, maxFps, maxSize });
                }
            }
        });
    } catch (err) {
        show(`error: ${err instanceof Error ? err.message : String(err)}`, true);
    }
}

/**
 * A small banner over the stream saying why the phone is silent. Kept apart
 * from #status, which the phone wall reads as the connection state. Clicking
 * it resumes audio (the click is the user gesture browsers want) without the
 * tap reaching the phone screen underneath.
 */
function createAudioNote(): { set(problem: string | undefined): void } {
    const note = document.createElement('div');
    note.id = 'audio-note';
    note.hidden = true;
    note.style.cssText =
        'position:fixed;left:8px;right:8px;bottom:8px;z-index:30;padding:6px 10px;border-radius:6px;' +
        'background:rgba(20,20,20,.86);color:#ffd27a;font:12px/1.45 system-ui,sans-serif;cursor:pointer;' +
        'text-align:center;';
    note.title = '点一下重试播放声音';
    note.addEventListener('click', (event) => {
        event.stopPropagation();
        window.postMessage({ type: 'phone-audio-resume' }, location.origin);
    });
    const attach = () => document.body?.appendChild(note);
    if (document.body) attach();
    else window.addEventListener('DOMContentLoaded', attach);
    return {
        set(problem) {
            note.textContent = problem ?? '';
            note.hidden = !problem;
        },
    };
}
