// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import type { MicSocketLike, MicTalkDeps } from '../MicTalkController';
import { MicTalkController, micSocketUrl } from '../MicTalkController';

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

    it('disables the button and shows the server reason when injection is unavailable', () => {
        const rig = deps();
        const button = mount(rig);
        status(rig.socket, false, '未安装虚拟麦克风模块，Android API 28 低于 13');
        expect(button.disabled).toBe(true);
        expect(button.title).toContain('未安装虚拟麦克风模块');
        expect(button.classList.contains('mic-talk')).toBe(true);
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
