// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MicSocketLike, MicTalkDeps } from '../MicTalkController';
import { MicTalkController, micSocketUrl } from '../MicTalkController';
import { MIC_BUSY_REASON } from '../../../common/micProtocol';

class FakeSocket implements MicSocketLike {
    readyState = 1;
    sent: Array<string | ArrayBuffer> = [];
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    send(data: string | ArrayBuffer): void {
        this.sent.push(data);
    }
    close(): void {
        this.closed = true;
        this.readyState = 3;
        this.onclose?.();
    }
}

const sockets: FakeSocket[] = [];
const cleanups: HTMLButtonElement[] = [];

beforeEach(() => {
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
});

afterEach(() => {
    while (cleanups.length) {
        const button = cleanups.pop();
        button?.dispatchEvent(new Event('stream-teardown'));
    }
    sockets.length = 0;
});

function mount(rig: { deps: MicTalkDeps }): HTMLButtonElement {
    const button = document.createElement('button');
    new MicTalkController('PHONE1', button, rig.deps);
    cleanups.push(button);
    return button;
}

function deps(capture = async () => () => undefined): { deps: MicTalkDeps; socket: FakeSocket; hold: () => void } {
    const socket = new FakeSocket();
    sockets.push(socket);
    let holdTimer: (() => void) | undefined;
    return {
        socket,
        hold: () => holdTimer?.(),
        deps: {
            connect: () => socket,
            capture,
            now: () => 0,
            schedule: (_ms, fn) => {
                holdTimer = fn;
                return () => {
                    holdTimer = undefined;
                };
            },
        },
    };
}

function status(socket: FakeSocket, supported: boolean, reason: string): void {
    socket.onmessage?.({
        data: JSON.stringify({
            type: 'status',
            supported,
            routes: supported ? ['shell'] : [],
            route: supported ? 'shell' : 'none',
            reason,
            active: false,
            rooted: false,
            bridgeInstalled: false,
            sdkInt: supported ? 34 : 28,
        }),
    });
}

describe('mic talk button', () => {
    it('builds a socket url on the existing mic action', () => {
        const url = new URL(micSocketUrl('phone:1'));
        expect(url.searchParams.get('action')).toBe('mic');
        expect(url.searchParams.get('udid')).toBe('phone:1');
    });

    it('keeps the enable action when the phone cannot inject yet', async () => {
        let captures = 0;
        const rig = deps(async () => {
            captures += 1;
            return () => undefined;
        });
        const button = mount(rig);
        status(rig.socket, false, '未安装虚拟麦克风模块，Android API 28 低于 13');
        expect(button.disabled).toBe(false);
        expect(button.querySelector('.mic-status')?.textContent).toBe('手机未就绪');
        expect(button.title).toContain('未安装虚拟麦克风模块');
        button.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1 }));
        await flush();
        expect(captures).toBe(1);
        expect(button.querySelector('.mic-status')?.textContent).toBe('已采集，手机未就绪');
        expect(button.title).toContain('不代表微信已经有声');
    });

    it('requests the microphone once from pointerdown and explains a refusal', async () => {
        let captures = 0;
        let stopped = false;
        const rig = deps(async () => {
            captures += 1;
            if (captures === 1) {
                const denied = new Error('denied');
                denied.name = 'NotAllowedError';
                throw denied;
            }
            return () => {
                stopped = true;
            };
        });
        const button = mount(rig);
        button.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1 }));
        button.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 2 }));
        await flush();
        expect(captures).toBe(1);
        expect(button.querySelector('.mic-status')?.textContent).toBe('麦克风未打开');
        expect(button.title).toContain('站点设置');
        button.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 3 }));
        await flush();
        expect(captures).toBe(2);
        expect(button.querySelector('.mic-status')?.textContent).toBe('已采集，手机未就绪');
        button.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 3 }));
        button.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 4 }));
        button.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 4 }));
        await flush();
        expect(stopped).toBe(true);
        expect(captures).toBe(2);
    });

    it('toggles continuous mode on a short click and press-to-talk on a hold', async () => {
        let captures = 0;
        const rig = deps(async () => {
            captures += 1;
            return () => undefined;
        });
        const el = mount(rig);
        status(rig.socket, true, '按住说话，单击切换通话');
        expect(el.disabled).toBe(false);

        el.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1 }));
        el.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 1 }));
        await flush();
        expect(captures).toBe(1);
        expect(jsons(rig.socket)).toContainEqual({ type: 'start', mode: 'continuous' });

        el.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1 }));
        el.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 1 }));
        await flush();
        expect(jsons(rig.socket).filter((msg) => msg.type === 'stop').length).toBeGreaterThan(0);

        rig.socket.sent.length = 0;
        el.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 2 }));
        rig.hold();
        await flush();
        el.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 2 }));
        await flush();
        expect(jsons(rig.socket)).toContainEqual({ type: 'start', mode: 'ptt' });
        expect(jsons(rig.socket).some((msg) => msg.type === 'stop')).toBe(true);
    });
});

describe('default browser microphone', () => {
    it('starts capture from the page message and does not restart after a persistent stop', async () => {
        let captures = 0;
        let stopped = false;
        const rig = deps(async () => {
            captures += 1;
            return () => {
                stopped = true;
            };
        });
        const button = mount(rig);
        status(rig.socket, false, '未能确认 Android 版本');
        window.dispatchEvent(new MessageEvent('message', {
            origin: location.origin,
            data: { type: 'phone-browser-mic', action: 'start' },
        }));
        await flush();
        expect(captures).toBe(1);
        expect(button.querySelector('.mic-status')?.textContent).toBe('已采集，手机未就绪');
        expect(button.title).not.toContain('站点设置');
        window.dispatchEvent(new MessageEvent('message', {
            origin: location.origin,
            data: { type: 'phone-browser-mic', action: 'stop', persist: true },
        }));
        expect(stopped).toBe(true);
        expect(button.querySelector('.mic-status')?.textContent).toBe('麦克风已关');
        window.dispatchEvent(new MessageEvent('message', {
            origin: location.origin,
            data: { type: 'phone-browser-mic', action: 'start' },
        }));
        await flush();
        expect(captures).toBe(1);
    });

    it('shows a browser denial instead of a phone-not-ready message', async () => {
        const rig = deps(async () => {
            const denied = new Error('no');
            denied.name = 'NotAllowedError';
            throw denied;
        });
        const button = mount(rig);
        window.dispatchEvent(new MessageEvent('message', {
            origin: location.origin,
            data: { type: 'phone-browser-mic', action: 'start' },
        }));
        await flush();
        expect(button.querySelector('.mic-status')?.textContent).toBe('麦克风未打开');
        expect(button.title).toContain('站点设置');
        expect(button.title).not.toContain('手机未就绪');
    });
});

describe('mic occupancy message', () => {
    it('keeps the exact busy sentence visible and does not treat it as capture success', async () => {
        const rig = deps(async () => () => undefined);
        const button = document.createElement('button');
        button.disabled = true;
        new MicTalkController('PHONE1', button, rig.deps);
        cleanups.push(button);
        status(rig.socket, false, MIC_BUSY_REASON);
        expect(button.disabled).toBe(false);
        expect(button.querySelector('.mic-status')?.textContent).toBe('手机被占用');
        expect(button.title).toContain(MIC_BUSY_REASON);
        expect(button.title).not.toContain('送往手机');
        button.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1 }));
        await flush();
        expect(button.querySelector('.mic-status')?.textContent).toBe('已采集，手机被占用');
        expect(button.title).toContain('不会把声音送进手机');
    });
});

function jsons(socket: FakeSocket): Array<{ type: string; mode?: string }> {
    return socket.sent
        .filter((item): item is string => typeof item === 'string')
        .map((item) => JSON.parse(item) as { type: string; mode?: string });
}

async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('mic socket reconnect', () => {
    it('reopens the socket after a drop and resumes continuous sending with the format', async () => {
        const opened: FakeSocket[] = [];
        const retries: Array<{ ms: number; fn: () => void }> = [];
        let emit: ((pcm: Int16Array, rate: number) => void) | undefined;
        const button = document.createElement('button');
        new MicTalkController('PHONE1', button, {
            connect: () => {
                const socket = new FakeSocket();
                opened.push(socket);
                return socket;
            },
            capture: async (onFrame) => {
                emit = onFrame;
                return () => undefined;
            },
            now: () => 0,
            schedule: () => () => undefined,
            retry: (ms, fn) => {
                retries.push({ ms, fn });
                return () => undefined;
            },
        });
        cleanups.push(button);
        const first = opened[0]!;
        status(first, true, '已就绪');
        button.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1 }));
        button.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 1 }));
        await flush();
        expect(jsons(first)).toContainEqual({ type: 'start', mode: 'continuous' });

        first.close();
        expect(button.querySelector('.mic-status')?.textContent).toBe('已采集，手机未就绪');
        expect(button.title).toContain('正在重连');
        expect(retries).toHaveLength(1);
        expect(retries[0]!.ms).toBe(1000);

        retries[0]!.fn();
        const second = opened[1]!;
        expect(second).toBeDefined();
        status(second, true, '已就绪');
        expect(jsons(second)).toContainEqual({ type: 'start', mode: 'continuous' });
        emit?.(new Int16Array(960), 48000);
        expect(jsons(second)).toContainEqual({ type: 'format', sampleRate: 48000 });
    });

    it('backs off and stops retrying once the button is torn down', () => {
        const retries: number[] = [];
        let connects = 0;
        const button = document.createElement('button');
        new MicTalkController('PHONE1', button, {
            connect: () => {
                connects += 1;
                const socket = new FakeSocket();
                queueMicrotask(() => socket.close());
                return socket;
            },
            capture: async () => () => undefined,
            now: () => 0,
            schedule: () => () => undefined,
            retry: (ms, fn) => {
                retries.push(ms);
                if (retries.length < 4) queueMicrotask(fn);
                return () => undefined;
            },
        });
        return new Promise<void>((resolve) => setTimeout(resolve, 5)).then(() => {
            expect(retries).toEqual([1000, 2000, 4000, 8000]);
            button.dispatchEvent(new Event('stream-teardown'));
            expect(connects).toBe(4);
        });
    });
});
