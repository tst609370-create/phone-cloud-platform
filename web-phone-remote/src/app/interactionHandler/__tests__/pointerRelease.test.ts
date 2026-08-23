import { describe, expect, it } from 'vitest';
import { isPointerReleaseType } from '../pointerRelease';

describe('isPointerReleaseType', () => {
    it('is true for touch, pointer and mouse release events', () => {
        expect(isPointerReleaseType('touchend')).toBe(true);
        expect(isPointerReleaseType('touchcancel')).toBe(true);
        expect(isPointerReleaseType('pointerup')).toBe(true);
        expect(isPointerReleaseType('pointercancel')).toBe(true);
        expect(isPointerReleaseType('mouseup')).toBe(true);
    });

    it('is false for non-release interaction types', () => {
        expect(isPointerReleaseType('touchstart')).toBe(false);
        expect(isPointerReleaseType('touchmove')).toBe(false);
        expect(isPointerReleaseType('pointerdown')).toBe(false);
        expect(isPointerReleaseType('pointermove')).toBe(false);
        expect(isPointerReleaseType('mousedown')).toBe(false);
        expect(isPointerReleaseType('mousemove')).toBe(false);
        expect(isPointerReleaseType('wheel')).toBe(false);
        expect(isPointerReleaseType('')).toBe(false);
    });
});
