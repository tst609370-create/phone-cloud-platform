// 「抽帧远控」模式（手机浏览器、http 公网地址常用）没有视频流，也就原本没有声音。
// 这里在控制台页面本身开一条只要声音的 scrcpy 会话（视频压到 320 像素 1 帧/秒 几乎不占流量），
// 在点「听声音」的那一下里创建 AudioContext，手机 Safari/微信内置浏览器也认这次点击。
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.PhoneAudio = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const CH_AUDIO = 1;
    const CH_METADATA = 4;
    const FLAG_CONFIG = 0x80000000;

    /** One WebSocket message → { kind, ... } or null. */
    function parseMessage(buf) {
        const raw = new Uint8Array(buf);
        if (raw.length < 1) return null;
        if (raw[0] === CH_METADATA) {
            try { return { kind: 'meta', meta: JSON.parse(new TextDecoder().decode(raw.subarray(1))) }; } catch { return null; }
        }
        if (raw[0] !== CH_AUDIO || raw.length < 13) return null;
        const view = new DataView(raw.buffer, raw.byteOffset + 1);
        const hi = view.getUint32(0);
        const size = view.getUint32(8);
        return {
            kind: 'audio',
            config: (hi & FLAG_CONFIG) !== 0,
            pts: (hi & 0x3fffffff) * 4294967296 + view.getUint32(4),
            data: raw.subarray(13, 13 + size),
        };
    }

    /** Interleaved stereo s16le → [left, right] Float32Arrays. */
    function s16ToFloat(data) {
        const frames = Math.floor(data.length / 4);
        const view = new DataView(data.buffer, data.byteOffset, frames * 4);
        const l = new Float32Array(frames);
        const r = new Float32Array(frames);
        for (let i = 0; i < frames; i++) {
            l[i] = view.getInt16(i * 4, true) / 32768;
            r[i] = view.getInt16(i * 4 + 2, true) / 32768;
        }
        return [l, r];
    }

    function sourceFor(serial) {
        try { return localStorage.getItem(`phone-audio-source:${serial}`) || ''; } catch { return ''; }
    }

    function streamUrl(serial, codec, source) {
        const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
        const q = new URLSearchParams({
            action: 'stream', udid: serial, audio: 'true',
            maxSize: '320', maxFps: '1', bitrate: '100000',
        });
        if (codec !== 'opus') q.set('audioCodec', codec);
        if (source === 'playback') { q.set('audioSource', 'playback'); q.set('audioDup', 'false'); }
        return `${scheme}://${location.host}/?${q}`;
    }

    /**
     * start(serial, onStatus) must be called inside the click handler.
     * onStatus(text, isProblem) reports progress and why it is silent.
     */
    function start(serial, onStatus) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) { onStatus('这个浏览器不能播放声音', true); return { stop() {} }; }
        const ctx = new Ctx();
        // iOS: a silent buffer played inside the tap unlocks output for good.
        try {
            const unlock = ctx.createBufferSource();
            unlock.buffer = ctx.createBuffer(1, 1, 22050);
            unlock.connect(ctx.destination);
            unlock.start(0);
        } catch { /* ignore */ }
        if (ctx.resume) ctx.resume().catch(() => undefined);

        const useOpus = window.isSecureContext && typeof window.AudioDecoder === 'function';
        const codec = useOpus ? 'opus' : 'raw';
        let decoder = null;
        let next = 0;
        let stopped = false;
        let gotAudio = false;
        let loud = false;
        let since = Date.now();
        let source = sourceFor(serial);
        let ws = null;
        onStatus('正在打开手机声音…', false);

        const play = (channels) => {
            const frames = channels[0].length;
            if (!frames || ctx.state !== 'running') return;
            if (!loud && channels.some((c) => c.some((v) => Math.abs(v) > 0.0005))) {
                loud = true;
                onStatus('', false);
            }
            const buffer = ctx.createBuffer(2, frames, 48000);
            buffer.getChannelData(0).set(channels[0]);
            buffer.getChannelData(1).set(channels[1] || channels[0]);
            const src = ctx.createBufferSource();
            src.buffer = buffer;
            src.connect(ctx.destination);
            const now = ctx.currentTime;
            if (next < now || next > now + 0.3) next = now + 0.08;
            src.start(next);
            next += buffer.duration;
        };

        if (useOpus) {
            decoder = new AudioDecoder({
                output: (audio) => {
                    const chans = [];
                    for (let c = 0; c < audio.numberOfChannels; c++) {
                        const a = new Float32Array(audio.numberOfFrames);
                        audio.copyTo(a, { planeIndex: c, format: 'f32-planar' });
                        chans.push(a);
                    }
                    audio.close();
                    play(chans);
                },
                error: (e) => onStatus(`声音解码失败：${e.message}`, true),
            });
            decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });
        }

        const onMessage = (event) => {
            const msg = parseMessage(event.data);
            if (!msg) return;
            if (msg.kind === 'meta') {
                const m = msg.meta || {};
                if ((m.audioCodec === 'disabled' || m.audioCodec === 'error') && m.audioReason) onStatus(`没有声音：${m.audioReason}`, true);
                return;
            }
            if (msg.config) return;
            if (!gotAudio) { gotAudio = true; since = Date.now(); }
            if (codec === 'raw') play(s16ToFloat(msg.data));
            else if (decoder && decoder.state === 'configured') {
                decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: msg.pts, data: msg.data }));
            }
        };
        const open = () => {
            gotAudio = false;
            since = Date.now();
            ws = new WebSocket(streamUrl(serial, codec, source));
            ws.binaryType = 'arraybuffer';
            ws.onmessage = onMessage;
            ws.onclose = onClose;
        };
        const onClose = (ev) => {
            if (stopped || ev.target !== ws) return;
            onStatus(`声音连接断开${ev.code ? `（${ev.code}${ev.reason ? ` ${ev.reason}` : ''}）` : ''}，再点一次「听声音」重试`, true);
        };

        open();
        const watchdog = setInterval(() => {
            if (stopped) return;
            if (ctx.state !== 'running') onStatus('浏览器还没放行声音：再点一下「听声音」', true);
            else if (!gotAudio && Date.now() - since > 6000) onStatus('手机没有送来声音数据，重连或重插 USB 再试', true);
            else if (gotAudio && !loud && Date.now() - since > 8000) {
                // 整机输出在部分机型（一加 ColorOS 14）只采到静音：自动换「应用播放」一次并记住。
                if (source !== 'playback') {
                    source = 'playback';
                    try { localStorage.setItem(`phone-audio-source:${serial}`, 'playback'); } catch { /* ignore */ }
                    onStatus('整机输出采到的是静音，已自动改用「应用播放」采集', false);
                    const old = ws;
                    old.onmessage = null;
                    open();
                    try { old.close(); } catch { /* ignore */ }
                } else {
                    onStatus('收到的全是静音：手机现在没在放声音，或手机媒体音量为 0', true);
                }
            }
        }, 2000);

        return {
            resume() { if (ctx.state !== 'running' && ctx.resume) ctx.resume().catch(() => undefined); },
            stop() {
                stopped = true;
                clearInterval(watchdog);
                try { ws.close(); } catch { /* ignore */ }
                try { if (decoder && decoder.state !== 'closed') decoder.close(); } catch { /* ignore */ }
                ctx.close().catch(() => undefined);
            },
        };
    }

    return { start, parseMessage, s16ToFloat, streamUrl, sourceFor };
});
