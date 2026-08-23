// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BasePlayer } from '../../player/BasePlayer';
import { TouchControlMessage } from '../../controlMessage/TouchControlMessage';
import MotionEvent from '../../MotionEvent';
import Rect from '../../Rect';
import ScreenInfo from '../../ScreenInfo';
import Size from '../../Size';
import { FeaturedInteractionHandler } from '../FeaturedInteractionHandler';

function createHarness() {
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'getContext', { value: () => null });
    canvas.getBoundingClientRect = () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 100,
        bottom: 200,
        width: 100,
        height: 200,
        toJSON: () => ({}),
    });
    document.body.appendChild(canvas);
    const player = {
        getTouchableElement: () => canvas,
        getScreenInfo: () => new ScreenInfo(new Rect(0, 0, 100, 200), new Size(100, 200), 0),
    } as unknown as BasePlayer;
    const sendMessage = vi.fn();
    const handler = new FeaturedInteractionHandler(player, { sendMessage });
    return { canvas, handler, sendMessage };
}

describe('direct canvas interaction', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        document.body.replaceChildren();
    });

    it('sends one message when the canvas event also bubbles to body', () => {
        const { canvas, handler, sendMessage } = createHarness();

        canvas.dispatchEvent(
            new MouseEvent('mousedown', {
                bubbles: true,
                cancelable: true,
                clientX: 50,
                clientY: 100,
                button: 0,
                buttons: 1,
            }),
        );

        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage.mock.calls[0]?.[0]).toBeInstanceOf(TouchControlMessage);
        handler.release();
    });

    it('uses TouchEvent as a fallback when PointerEvent exists but never fires', () => {
        vi.stubGlobal('PointerEvent', class extends MouseEvent {});
        const { canvas, handler, sendMessage } = createHarness();
        const event = new TouchEvent('touchstart', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'changedTouches', {
            value: [{ identifier: 1, target: canvas, clientX: 50, clientY: 100, force: 1 }],
        });

        canvas.dispatchEvent(event);

        expect(sendMessage).toHaveBeenCalledTimes(1);
        handler.release();
    });

    it('keeps a WebKit pointer gesture when move and up are retargeted to body', () => {
        class TestPointerEvent extends MouseEvent {
            readonly pointerId = 7;
            readonly pointerType = 'mouse';
        }
        vi.stubGlobal('PointerEvent', TestPointerEvent);
        const { canvas, handler, sendMessage } = createHarness();

        canvas.dispatchEvent(new TestPointerEvent('pointerdown', {
            bubbles: true, cancelable: true, clientX: 40, clientY: 150, button: 0, buttons: 1,
        }));
        document.body.dispatchEvent(new TestPointerEvent('pointermove', {
            bubbles: true, cancelable: true, clientX: 40, clientY: 50, button: 0, buttons: 1,
        }));
        document.body.dispatchEvent(new TestPointerEvent('pointerup', {
            bubbles: true, cancelable: true, clientX: 40, clientY: 50, button: 0, buttons: 0,
        }));

        expect(sendMessage.mock.calls.map(([message]) => message.action)).toEqual([
            MotionEvent.ACTION_DOWN,
            MotionEvent.ACTION_MOVE,
            MotionEvent.ACTION_UP,
        ]);
        handler.release();
    });
});
