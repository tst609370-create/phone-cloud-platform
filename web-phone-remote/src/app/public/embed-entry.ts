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
    readBool('audioDup');
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

    const audioNote = createAudioNote(deviceId);
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
            show(
                'error: 视频 20 秒没连上。检查电脑上的服务和中转是否在线，或点刷新重连；手机浏览器请用 Chrome / Edge',
                true,
            );
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
function createAudioNote(deviceId: string): { set(problem: string | undefined): void } {
    const note = document.createElement('div');
    note.id = 'audio-note';
    note.hidden = true;
    note.style.cssText =
        // 只占顶部一行小条，不挡手机画面下半部分（导航栏、输入框）；点一下展开完整原因。
        'position:fixed;left:6px;top:6px;max-width:calc(100% - 12px);z-index:30;padding:2px 8px;border-radius:999px;' +
        'background:rgba(20,20,20,.72);color:#ffd27a;font:11px/1.5 system-ui,sans-serif;cursor:pointer;' +
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;';
    note.title = '点一下展开完整原因并重试播放声音';
    // 手机浏览器没有悬停：点一下展开成多行显示完整原因，再点收起。
    let expanded = false;
    const applyExpanded = () => {
        note.style.whiteSpace = expanded ? 'normal' : 'nowrap';
        note.style.borderRadius = expanded ? '10px' : '999px';
        note.style.maxHeight = expanded ? '60vh' : '';
        note.style.overflowY = expanded ? 'auto' : 'hidden';
        note.style.userSelect = expanded ? 'text' : '';
    };
    note.addEventListener('click', (event) => {
        event.stopPropagation();
        expanded = !expanded;
        applyExpanded();
        window.postMessage({ type: 'phone-audio-resume' }, location.origin);
    });
    const text = document.createElement('span');
    note.appendChild(text);
    // 安卓 8-10 没 ROOT：一键装「手机声音」App（含授权），装好自动重连听声音。
    const installBtn = document.createElement('button');
    installBtn.type = 'button';
    installBtn.textContent = '安装手机声音 App';
    installBtn.hidden = true;
    installBtn.style.cssText =
        'margin-left:6px;padding:0 8px;border:0;border-radius:999px;background:#ffd27a;color:#222;' +
        'font:600 11px/1.6 system-ui,sans-serif;cursor:pointer;vertical-align:middle;';
    installBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        installBtn.disabled = true;
        installBtn.textContent = '正在安装…';
        try {
            const response = await fetch('/api/apks/install-sound', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ devices: [deviceId] }),
            });
            const result = (await response.json().catch(() => ({}))) as {
                error?: string;
                results?: { ok: boolean; error?: string }[];
            };
            const first = result.results?.[0];
            if (!first?.ok) throw new Error(first?.error || result.error || `安装失败（${response.status}）`);
            installBtn.textContent = '已装好，正在重连…';
            setTimeout(() => location.reload(), 1200);
        } catch (err) {
            installBtn.disabled = false;
            installBtn.textContent = '重新安装';
            text.textContent = `安装失败：${err instanceof Error ? err.message : String(err)}`;
            expanded = true;
            applyExpanded();
        }
    });
    note.appendChild(installBtn);
    const attach = () => document.body?.appendChild(note);
    if (document.body) attach();
    else window.addEventListener('DOMContentLoaded', attach);
    return {
        set(problem) {
            text.textContent = problem ?? '';
            installBtn.hidden = !problem || !/手机声音|录音小程序|ROOT/.test(problem);
            if (!installBtn.hidden && !installBtn.disabled) installBtn.textContent = '安装手机声音 App';
            note.title = problem ? `${problem}\n（点一下展开/收起，并重试播放声音）` : '点一下重试播放声音';
            note.hidden = !problem;
        },
    };
}
