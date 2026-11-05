import { describe, expect, it } from 'vitest';
import { initialMicGesture, MIC_HOLD_MS, reduceMicGesture } from '../micGesture';

describe('mic gesture', () => {
    it('treats a short press as a continuous toggle', () => {
        let state = initialMicGesture();
        state = reduceMicGesture(state, { type: 'down', now: 0 }).state;
        const up = reduceMicGesture(state, { type: 'up', now: MIC_HOLD_MS - 1 });
        expect(up.effects).toEqual(['continuous-on']);
        const again = reduceMicGesture(up.state, { type: 'down', now: 1000 });
        const off = reduceMicGesture(again.state, { type: 'up', now: 1100 });
        expect(off.effects).toEqual(['continuous-off']);
    });

    it('starts press-to-talk only after the hold threshold and stops on release', () => {
        let state = initialMicGesture();
        state = reduceMicGesture(state, { type: 'down', now: 0 }).state;
        const held = reduceMicGesture(state, { type: 'hold', now: MIC_HOLD_MS });
        expect(held.effects).toEqual(['ptt-start']);
        const released = reduceMicGesture(held.state, { type: 'up', now: MIC_HOLD_MS + 20 });
        expect(released.effects).toEqual(['ptt-stop']);
        expect(released.state.continuous).toBe(false);
    });

    it('does not toggle continuous when a press is cancelled', () => {
        let state = initialMicGesture();
        state = reduceMicGesture(state, { type: 'down', now: 0 }).state;
        const cancelled = reduceMicGesture(state, { type: 'cancel', now: 10 });
        expect(cancelled.effects).toEqual([]);
        expect(cancelled.state.continuous).toBe(false);
        expect(cancelled.state.phase).toBe('idle');
    });

    it('keeps a continuous session running across a later long press', () => {
        let state = initialMicGesture();
        state = reduceMicGesture(state, { type: 'down', now: 0 }).state;
        state = reduceMicGesture(state, { type: 'up', now: 10 }).state;
        state = reduceMicGesture(state, { type: 'down', now: 50 }).state;
        const held = reduceMicGesture(state, { type: 'hold', now: 50 + MIC_HOLD_MS });
        expect(held.effects).toEqual([]);
        expect(held.state.continuous).toBe(true);
        const released = reduceMicGesture(held.state, { type: 'up', now: 900 });
        expect(released.effects).toEqual([]);
        expect(released.state.continuous).toBe(true);
    });
});
