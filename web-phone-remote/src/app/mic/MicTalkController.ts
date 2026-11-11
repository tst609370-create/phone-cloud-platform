import { ACTION } from '../../common/Action';
import { MIC_BUSY_REASON } from '../../common/micProtocol';
import { ToolBoxButton } from '../toolbox/ToolBoxButton';
import SvgImage from '../ui/SvgImage';
import { captureMicrophone, describeMicCaptureError } from './micCapture';
import {
    initialMicGesture,
    insecureMicReason,
    MIC_HOLD_MS,
    type MicGestureEffect,
    type MicGestureState,
    reduceMicGesture,
} from './micGesture';

export interface MicSocketLike {
    readyState: number;
    binaryType?: BinaryType;
    send(data: string | ArrayBuffer): void;
    close(): void;
    onmessage: ((ev: { data: unknown }) => void) | null;
    onclose: (() => void) | null;
    onerror: (() => void) | null;
}

export interface MicTalkDeps {
    connect(udid: string): MicSocketLike;
    capture(onFrame: (pcm: Int16Array, sampleRate: number) => void): Promise<() => void>;
    now(): number;
    schedule(ms: number, fn: () => void): () => void;
    /** Timer for socket reconnects; kept apart from the hold timer. Defaults to setTimeout. */
    retry?(ms: number, fn: () => void): () => void;
}

const RECONNECT_MS = [1000, 2000, 4000, 8000];

const defaultDeps: MicTalkDeps = {
    connect: (udid) => {
        const ws = new WebSocket(micSocketUrl(udid));
        ws.binaryType = 'arraybuffer';
        return ws as MicSocketLike;
    },
    capture: captureMicrophone,
    now: () => Date.now(),
    schedule: (ms, fn) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
    },
};

export function micSocketUrl(udid: string): string {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = new URL(`${protocol}://${window.location.host}/`);
    url.searchParams.set('action', ACTION.MIC_INJECT);
    url.searchParams.set('udid', udid);
    return url.toString();
}

export function createMicTalkButton(udid: string, deps?: MicTalkDeps): ToolBoxButton {
    const button = new ToolBoxButton('正在检测麦克风…', SvgImage.Icon.MIC);
    const el = button.getElement();
    el.classList.add('mic-talk');
    el.type = 'button';
    new MicTalkController(udid, el, deps);
    return button;
}

/**
 * Toolbar microphone. A short click toggles continuous injection (voice calls).
 * Holding past {@link MIC_HOLD_MS} is press-to-talk and stops on release.
 */
export class MicTalkController {
    private socket: MicSocketLike | undefined;
    private gesture: MicGestureState = initialMicGesture();
    private deviceReady = false;
    private deviceReason = '正在确认手机能不能注入麦克风';
    private captureState: 'idle' | 'requesting' | 'capturing' | 'failed' = 'idle';
    private captureReason = '';
    private captureStop: (() => void) | undefined;
    private captureInflight: Promise<boolean> | undefined;
    private captureGen = 0;
    private cancelHold: (() => void) | undefined;
    private sending = false;
    private sentRate = 0;
    private closed = false;
    private userPaused = false;
    private reconnects = 0;
    private cancelReconnect: (() => void) | undefined;
    private readonly statusEl: HTMLSpanElement;
    private readonly onBrowserMic = (event: MessageEvent): void => {
        if (event.origin !== location.origin) return;
        const data = event.data as { type?: string; action?: string; persist?: boolean } | null;
        if (!data || data.type !== 'phone-browser-mic') return;
        if (data.action === 'start') {
            if (this.userPaused || this.closed) return;
            void this.beginBrowserMic();
            return;
        }
        if (data.action === 'stop') {
            if (data.persist) this.userPaused = true;
            this.sending = false;
            this.gesture = initialMicGesture();
            this.cancelHold?.();
            this.cancelHold = undefined;
            this.stopCapture();
            this.sendJson({ type: 'stop' });
            this.render();
        }
    };

    constructor(
        private readonly udid: string,
        private readonly el: HTMLButtonElement,
        private readonly deps: MicTalkDeps = defaultDeps,
    ) {
        this.el.classList.add('mic-talk');
        this.statusEl = document.createElement('span');
        this.statusEl.className = 'mic-status';
        this.el.appendChild(this.statusEl);
        const secure = typeof window.isSecureContext === 'boolean' ? window.isSecureContext : true;
        const blocked = insecureMicReason(secure);
        if (blocked) {
            this.captureState = 'failed';
            this.captureReason = blocked;
            this.render();
            this.el.disabled = true;
            this.el.addEventListener('stream-teardown', this.close);
            window.addEventListener('pagehide', this.close);
            window.addEventListener('beforeunload', this.close);
            return;
        }
        window.addEventListener('message', this.onBrowserMic);
        this.el.addEventListener('pointerdown', this.onPointerDown);
        this.el.addEventListener('pointerup', this.onPointerUp);
        this.el.addEventListener('pointercancel', this.onPointerCancel);
        this.el.addEventListener('keydown', this.onKeyDown);
        this.el.addEventListener('stream-teardown', this.close);
        window.addEventListener('pagehide', this.close);
        window.addEventListener('beforeunload', this.close);
        this.openSocket();
        this.render();
    }

    private openSocket(): void {
        let socket: MicSocketLike;
        try {
            socket = this.deps.connect(this.udid);
        } catch {
            this.deviceReason = '无法连接麦克风服务';
            this.scheduleReconnect();
            return;
        }
        this.socket = socket;
        socket.onmessage = (event) => {
            if (this.socket !== socket) return;
            this.reconnects = 0;
            this.onSocketMessage(event.data);
        };
        socket.onclose = () => {
            if (this.closed || this.socket !== socket) return;
            this.socket = undefined;
            this.deviceReady = false;
            this.deviceReason = '手机端麦克风连接已断开，正在重连';
            // A held press-to-talk ends here; continuous mode keeps the browser
            // microphone open and resumes sending once the new socket is ready.
            this.sending = false;
            this.sentRate = 0;
            if (!this.gesture.continuous && this.gesture.phase !== 'idle') this.stopSending();
            this.scheduleReconnect();
            this.render();
        };
        socket.onerror = () => {
            if (this.deviceReady || this.socket !== socket) return;
            this.deviceReason = '无法连接手机端麦克风服务';
            this.render();
        };
    }

    private scheduleReconnect(): void {
        if (this.closed || this.cancelReconnect) return;
        const delay = RECONNECT_MS[Math.min(this.reconnects, RECONNECT_MS.length - 1)] ?? 8000;
        this.reconnects += 1;
        const retry =
            this.deps.retry ??
            ((ms: number, fn: () => void) => {
                const timer = setTimeout(fn, ms);
                return () => clearTimeout(timer);
            });
        this.cancelReconnect = retry(delay, () => {
            this.cancelReconnect = undefined;
            if (this.closed) return;
            this.openSocket();
            this.render();
        });
    }

    close = (): void => {
        if (this.closed) return;
        this.closed = true;
        this.cancelReconnect?.();
        this.cancelReconnect = undefined;
        this.cancelHold?.();
        this.stopSending();
        this.socket?.close();
        this.el.removeEventListener('pointerdown', this.onPointerDown);
        this.el.removeEventListener('pointerup', this.onPointerUp);
        this.el.removeEventListener('pointercancel', this.onPointerCancel);
        this.el.removeEventListener('keydown', this.onKeyDown);
        this.el.removeEventListener('stream-teardown', this.close);
        window.removeEventListener('pagehide', this.close);
        window.removeEventListener('beforeunload', this.close);
        window.removeEventListener('message', this.onBrowserMic);
    };

    private onPointerDown = (ev: PointerEvent): void => {
        if (ev.button !== 0 || this.el.disabled) return;
        if (this.userPaused) this.userPaused = false;
        if (this.captureState !== 'capturing') {
            void this.ensureCapture();
        }
        if (typeof this.el.setPointerCapture === 'function') {
            try {
                this.el.setPointerCapture(ev.pointerId);
            } catch {
                // jsdom and a few embedded webviews omit pointer capture
            }
        }
        ev.preventDefault();
        this.apply({ type: 'down', now: this.deps.now() });
    };

    private onPointerUp = (ev: PointerEvent): void => {
        if (ev.button !== 0) return;
        this.apply({ type: 'up', now: this.deps.now() });
    };

    private onPointerCancel = (): void => {
        this.apply({ type: 'cancel', now: this.deps.now() });
    };

    private onKeyDown = (ev: KeyboardEvent): void => {
        if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
        if (ev.repeat || this.el.disabled) return;
        ev.preventDefault();
        const now = this.deps.now();
        this.apply({ type: 'down', now });
        this.apply({ type: 'up', now });
    };

    private onSocketMessage(data: unknown): void {
        if (typeof data !== 'string') return;
        let msg: { type?: string; reason?: string; supported?: boolean };
        try {
            msg = JSON.parse(data) as { type?: string; reason?: string; supported?: boolean };
        } catch {
            return;
        }
        if (msg.type === 'error' && msg.reason) {
            this.deviceReady = false;
            this.deviceReason = msg.reason;
            this.render();
            return;
        }
        if (msg.type !== 'status') return;
        this.deviceReady = msg.supported === true;
        this.deviceReason = msg.reason || (this.deviceReady ? '手机端可以接收电脑麦克风' : '手机端还不能注入麦克风');
        if (!this.deviceReady) this.sending = false;
        else if (this.captureState === 'capturing' && !this.userPaused && !this.sending) {
            this.sending = true;
            this.sendJson({ type: 'start', mode: 'continuous' });
        }
        this.render();
    }

    private async beginBrowserMic(): Promise<void> {
        const opened = await this.ensureCapture();
        if (!opened || this.userPaused || this.closed) return;
        this.sending = this.deviceReady;
        if (this.sending) this.sendJson({ type: 'start', mode: 'continuous' });
        this.render();
    }

    private apply(event: { type: 'down' | 'up' | 'hold' | 'cancel'; now: number }): void {
        if (this.closed) return;
        const next = reduceMicGesture(this.gesture, event);
        this.gesture = next.state;
        if (event.type === 'down') {
            this.cancelHold?.();
            this.cancelHold = this.deps.schedule(MIC_HOLD_MS, () => {
                this.cancelHold = undefined;
                this.apply({ type: 'hold', now: this.deps.now() });
            });
        }
        if (event.type === 'up' || event.type === 'cancel') {
            this.cancelHold?.();
            this.cancelHold = undefined;
        }
        for (const effect of next.effects) this.onEffect(effect);
        this.render();
    }

    private onEffect(effect: MicGestureEffect): void {
        if (effect === 'ptt-start' || effect === 'continuous-on') {
            this.sending = true;
            void this.ensureCapture().then((opened) => {
                if (!opened || !this.sending) return;
                this.sendJson({ type: 'start', mode: effect === 'ptt-start' ? 'ptt' : 'continuous' });
            });
            return;
        }
        this.sending = this.gesture.continuous && this.gesture.phase !== 'idle';
        if (!this.gesture.continuous) {
            this.sending = false;
            this.stopCapture();
        }
        this.sendJson({ type: 'stop' });
    }

    private async ensureCapture(): Promise<boolean> {
        if (this.captureStop) return true;
        if (this.captureInflight) return this.captureInflight;
        const gen = ++this.captureGen;
        this.captureState = 'requesting';
        this.captureReason = '';
        this.render();
        const run = (async () => {
            try {
                const stop = await this.deps.capture((pcm, rate) => this.onPcm(pcm, rate));
                if (gen !== this.captureGen || this.closed) {
                    stop();
                    return false;
                }
                this.captureStop = stop;
                this.captureState = 'capturing';
                this.render();
                return true;
            } catch (err) {
                if (gen !== this.captureGen || this.closed) return false;
                this.captureState = 'failed';
                this.captureReason = describeMicCaptureError(err);
                this.sending = false;
                this.gesture = initialMicGesture();
                this.render();
                return false;
            }
        })();
        this.captureInflight = run;
        try {
            return await run;
        } finally {
            if (this.captureInflight === run) this.captureInflight = undefined;
        }
    }

    private onPcm(pcm: Int16Array, sampleRate: number): void {
        const socket = this.socket;
        if (!this.sending || socket === undefined || socket.readyState !== 1) return;
        if (sampleRate !== this.sentRate) {
            this.sentRate = sampleRate;
            this.sendJson({ type: 'format', sampleRate });
        }
        const copy = new Uint8Array(pcm.byteLength);
        copy.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
        socket.send(copy.buffer);
    }

    private stopSending(): void {
        this.sending = false;
        this.gesture = initialMicGesture();
        this.cancelHold?.();
        this.cancelHold = undefined;
        this.stopCapture();
    }

    private stopCapture(): void {
        this.captureGen += 1;
        const stop = this.captureStop;
        this.captureStop = undefined;
        this.sentRate = 0;
        if (this.captureState === 'capturing' || this.captureState === 'requesting') this.captureState = 'idle';
        stop?.();
    }

    private sendJson(
        body: { type: 'start'; mode: 'ptt' | 'continuous' } | { type: 'stop' } | { type: 'format'; sampleRate: number },
    ): void {
        const socket = this.socket;
        if (socket === undefined || socket.readyState !== 1) return;
        socket.send(JSON.stringify(body));
    }

    private render(): void {
        const phoneBusy = this.deviceReason === MIC_BUSY_REASON;
        const live = this.deviceReady && this.captureState === 'capturing' && (this.gesture.continuous || this.gesture.phase === 'ptt' || this.sending);
        this.el.disabled = false;
        this.el.classList.toggle('mic-live', live);
        let label = this.userPaused ? '麦克风已关' : '启用麦克风';
        let title = this.userPaused
            ? '浏览器麦克风已关闭，不会自动重新打开。点此再开。这不是手机注入失败。'
            : '点一下请求电脑麦克风。浏览器若已经允许，不会再弹窗。';
        if (this.captureState === 'requesting') {
            label = '正在请求';
            title = '正在向浏览器请求麦克风，请看系统是否弹出权限。';
        } else if (this.captureState === 'failed') {
            label = '麦克风未打开';
            title = this.captureReason;
        } else if (this.userPaused) {
            label = '麦克风已关';
            title = '浏览器麦克风已关闭，不会自动重新打开。点此再开。这不是手机注入失败。';
        } else if (phoneBusy) {
            label = this.captureState === 'capturing' ? '已采集，手机被占用' : '手机被占用';
            title = `${MIC_BUSY_REASON}。这只表示已有控制端占着送音名额。电脑可以单独采集，但不会把声音送进手机，也不代表微信有声。`;
        } else if (this.captureState === 'capturing' && !this.deviceReady) {
            label = '已采集，手机未就绪';
            title = `电脑麦克风已授权并正在采集。${this.deviceReason}。这不代表微信已经有声。`;
        } else if (this.captureState === 'capturing') {
            label = this.sending ? '已采集，送往手机' : '已采集，未发送';
            title = '电脑麦克风已授权并正在采集。送到手机不等于微信通话或按住说话已经有声。';
        } else if (!this.deviceReady) {
            label = '手机未就绪';
            title = `${this.deviceReason}。点一下仍会请求电脑麦克风，不会把它说成被别人占用。`;
        }
        this.statusEl.textContent = label;
        this.el.title = title;
        this.el.setAttribute('aria-label', `${label}。${title}`);
        this.el.setAttribute('aria-pressed', live ? 'true' : 'false');
        if (window.parent !== window) {
            window.parent.postMessage(
                {
                    type: 'phone-browser-mic-state',
                    capture: this.userPaused ? 'closed-by-user' : this.captureState,
                    deviceReady: this.deviceReady,
                    phoneReason: this.deviceReason,
                },
                location.origin,
            );
        }
    }
}
