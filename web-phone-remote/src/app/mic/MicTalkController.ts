import { ACTION } from '../../common/Action';
import { ToolBoxButton } from '../toolbox/ToolBoxButton';
import SvgImage from '../ui/SvgImage';
import { captureMicrophone } from './micCapture';
import {
    initialMicGesture,
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
}

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
    el.disabled = true;
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
    private supported = false;
    private serverReason = '正在检测麦克风…';
    private captureStop: (() => void) | undefined;
    private cancelHold: (() => void) | undefined;
    private sending = false;
    private sentRate = 0;
    private closed = false;

    constructor(
        udid: string,
        private readonly el: HTMLButtonElement,
        private readonly deps: MicTalkDeps = defaultDeps,
    ) {
        this.el.classList.add('mic-talk');
        this.el.addEventListener('pointerdown', this.onPointerDown);
        this.el.addEventListener('pointerup', this.onPointerUp);
        this.el.addEventListener('pointercancel', this.onPointerCancel);
        this.el.addEventListener('keydown', this.onKeyDown);
        this.el.addEventListener('stream-teardown', this.close);
        window.addEventListener('pagehide', this.close);
        window.addEventListener('beforeunload', this.close);
        try {
            this.socket = this.deps.connect(udid);
        } catch {
            this.serverReason = '无法连接麦克风服务';
            this.render();
            return;
        }
        this.socket.onmessage = (event) => this.onSocketMessage(event.data);
        this.socket.onclose = () => {
            if (this.closed) return;
            this.supported = false;
            this.serverReason = '麦克风连接已断开';
            this.stopSending();
            this.render();
        };
        this.socket.onerror = () => {
            if (this.supported) return;
            this.serverReason = '无法连接麦克风服务';
            this.render();
        };
        this.render();
    }

    close = (): void => {
        if (this.closed) return;
        this.closed = true;
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
    };

    private onPointerDown = (ev: PointerEvent): void => {
        if (ev.button !== 0 || this.el.disabled) return;
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
            this.serverReason = msg.reason;
            this.render();
            return;
        }
        if (msg.type !== 'status') return;
        this.supported = msg.supported === true;
        this.serverReason = msg.reason || (this.supported ? '按住说话，单击切换通话' : '这台手机不能注入麦克风');
        if (!this.supported) this.stopSending();
        this.render();
    }

    private apply(event: { type: 'down' | 'up' | 'hold' | 'cancel'; now: number }): void {
        if (this.closed) return;
        if (!this.supported && event.type === 'down') return;
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
            void this.ensureCapture()
                .then((opened) => {
                    if (!opened || !this.sending) return;
                    this.sendJson({ type: 'start', mode: effect === 'ptt-start' ? 'ptt' : 'continuous' });
                })
                .catch((err: unknown) => {
                    this.gesture = initialMicGesture();
                    this.sending = false;
                    this.serverReason = err instanceof Error ? err.message : '无法打开电脑麦克风';
                    this.sendJson({ type: 'stop' });
                    this.render();
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
        const stop = await this.deps.capture((pcm, rate) => this.onPcm(pcm, rate));
        if (!this.sending || this.closed) {
            stop();
            return false;
        }
        this.captureStop = stop;
        return true;
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
        const stop = this.captureStop;
        this.captureStop = undefined;
        this.sentRate = 0;
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
        const live = this.supported && (this.gesture.continuous || this.gesture.phase === 'ptt' || this.sending);
        this.el.disabled = !this.supported;
        this.el.classList.toggle('mic-live', live);
        let title = this.serverReason;
        if (this.supported && this.gesture.phase === 'ptt') title = '正在用电脑麦克风说话，松开结束';
        else if (this.supported && this.gesture.continuous) title = '电脑麦克风已作为手机麦克风，再次单击关闭';
        else if (this.supported && !this.serverReason) title = '按住说话，单击切换通话';
        this.el.title = title;
        this.el.setAttribute('aria-label', title);
        this.el.setAttribute('aria-pressed', live ? 'true' : 'false');
    }
}
