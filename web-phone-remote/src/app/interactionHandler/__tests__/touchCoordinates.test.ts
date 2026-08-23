import { describe, expect, it } from 'vitest';
import Rect from '../../Rect';
import ScreenInfo from '../../ScreenInfo';
import Size from '../../Size';
import { InteractionHandler } from '../InteractionHandler';

abstract class TestInteractionHandler extends InteractionHandler {
    public static mapPoint(
        event: { clientX: number; clientY: number; type: string; target: EventTarget | null; buttons: number },
        screenInfo: ScreenInfo,
    ) {
        const result = super.buildTouchOnClient(event, screenInfo);
        return result && {
            client: result.client,
            point: result.touch.position.point,
            invalid: result.touch.invalid,
        };
    }
}

describe('touch coordinate mapping', () => {
    it('uses the transformed visual bounds', () => {
        const target = {
            clientWidth: 500,
            clientHeight: 1000,
            getBoundingClientRect: () => ({ left: 10, top: 20, width: 250, height: 500 }),
        } as unknown as HTMLElement;
        const screenInfo = new ScreenInfo(new Rect(0, 0, 1000, 2000), new Size(1000, 2000), 0);

        const result = TestInteractionHandler.mapPoint(
            { clientX: 135, clientY: 270, type: 'mousedown', target, buttons: 1 },
            screenInfo,
        );

        expect(result).not.toBeNull();
        expect(result?.client).toEqual({ width: 250, height: 500 });
        expect(result?.point.toJSON()).toEqual({ x: 500, y: 1000 });
        expect(result?.invalid).toBe(false);
    });
});
