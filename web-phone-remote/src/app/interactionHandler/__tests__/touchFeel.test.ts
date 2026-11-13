// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScrollControlMessage } from '../../controlMessage/ScrollControlMessage';
import type { TouchControlMessage } from '../../controlMessage/TouchControlMessage';
import MotionEvent from '../../MotionEvent';
import type { BasePlayer } from '../../player/BasePlayer';
import Rect from '../../Rect';
import ScreenInfo from '../../ScreenInfo';
import Size from '../../Size';
import { FeaturedInteractionHandler } from '../FeaturedInteractionHandler';

function createHarness() {
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'getContext', { value: () => null });
    canvas.getBoundingClientRect = () =>
        ({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 100,
            bottom: 200,
            width: 100,
            height: 200,
            toJSON: () => ({}),
        }) as DOMRect;
    document.body.appendChild(canvas);
    const player = {
        getTouchableElement: () => canvas,
        getScreenInfo: () => new ScreenInfo(new Rect(0, 0, 100, 200), new Size(100, 200), 0),
    } as unknown as BasePlayer;
    const sendMessage = vi.fn();
    const handler = new FeaturedInteractionHandler(player, { sendMessage });
    return { canvas, handler, sendMessage };
}

function pointerClass(pointerType: string) {
    return class extends MouseEvent {
        readonly pointerId: number;
        readonly pointerType = pointerType;
        readonly pressure = 0.5;
        constructor(type: string, init: MouseEventInit & { pointerId?: number }) {
            super(type, init);
            this.pointerId = init.pointerId ?? 1;
        }
    };
}

const touches = (fn: ReturnType<typeof vi.fn>) =>
    fn.mock.calls.map((c) => c[0] as TouchControlMessage).filter((m) => 'pointerId' in m);

describe('touch feel', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        document.body.replaceChildren();
    });

    it('keeps a drag that overshoots the picture edge on the edge and lifts it there', () => {
        const PE = pointerClass('mouse');
        vi.stubGlobal('PointerEvent', PE);
        const { canvas, handler, sendMessage } = createHarness();
        const fire = (type: string, x: number, y: number, buttons: number) =>
            canvas.dispatchEvent(new PE(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, buttons }));
        fire('pointerdown', 50, 20, 1);
        fire('pointermove', 50, -30, 1); // pulled above the top edge
        fire('pointerup', 50, -40, 0);
        const msgs = touches(sendMessage);
        expect(msgs.map((m) => m.action)).toEqual([
            MotionEvent.ACTION_DOWN,
            MotionEvent.ACTION_MOVE,
            MotionEvent.ACTION_UP,
        ]);
        expect(msgs[1]!.position.point.y).toBe(0);
        expect(msgs[2]!.position.point.y).toBe(0);
        handler.release();
    });

    it('gives each finger its own pointer id so pinch works and one finger lifting keeps the other', () => {
        const PE = pointerClass('touch');
        vi.stubGlobal('PointerEvent', PE);
        const { canvas, handler, sendMessage } = createHarness();
        const fire = (type: string, id: number, x: number, y: number) =>
            canvas.dispatchEvent(
                new PE(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, buttons: 1, pointerId: id }),
            );
        fire('pointerdown', 11, 30, 100);
        fire('pointerdown', 12, 70, 100);
        fire('pointermove', 11, 20, 100);
        fire('pointermove', 12, 80, 100);
        fire('pointerup', 11, 20, 100);
        fire('pointermove', 12, 90, 100);
        const msgs = touches(sendMessage);
        expect(msgs.map((m) => [m.action, m.pointerId])).toEqual([
            [MotionEvent.ACTION_DOWN, 0],
            [MotionEvent.ACTION_DOWN, 1],
            [MotionEvent.ACTION_MOVE, 0],
            [MotionEvent.ACTION_MOVE, 1],
            [MotionEvent.ACTION_UP, 0],
            [MotionEvent.ACTION_MOVE, 1],
        ]);
        expect(msgs[0]!.pressure).toBe(0.5);
        handler.release();
    });

    it('turns wheel movement into proportional scrolling merged per frame', () => {
        vi.useFakeTimers();
        vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 16));
        const { canvas, handler, sendMessage } = createHarness();
        const wheel = (dy: number) =>
            canvas.dispatchEvent(
                new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 50, clientY: 100, deltaY: dy }),
            );
        wheel(30);
        wheel(70); // trackpad burst in one frame
        expect(sendMessage).not.toHaveBeenCalled();
        vi.advanceTimersByTime(20);
        expect(sendMessage).toHaveBeenCalledTimes(1);
        const msg = sendMessage.mock.calls[0]![0] as ScrollControlMessage;
        expect(msg).toBeInstanceOf(ScrollControlMessage);
        expect(msg.vScroll).toBeCloseTo(-8); // 100 px down = one Android scroll unit (8 ticks)
        vi.useRealTimers();
        handler.release();
    });
});
