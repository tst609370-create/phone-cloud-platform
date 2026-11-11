import { describe, expect, it } from 'vitest';
import { clampMaxSize, defaultCapForModel, nextCap } from '../videoSizeCap';

describe('videoSizeCap', () => {
    it('locks OnePlus 9 (LE21xx) to 1080 by default', () => {
        expect(defaultCapForModel('LE2100')).toBe(1080);
        expect(defaultCapForModel('Pixel 7')).toBe(0);
        expect(defaultCapForModel(undefined)).toBe(0);
    });

    it('clamps larger or unlimited requests to the cap', () => {
        expect(clampMaxSize(2400, 1080)).toBe(1080);
        expect(clampMaxSize(0, 1080)).toBe(1080);
        expect(clampMaxSize(undefined, 1080)).toBe(1080);
        expect(clampMaxSize(1080, 1600)).toBe(1080);
        expect(clampMaxSize(2400, 0)).toBe(2400);
    });

    it('only ever lowers a stored cap', () => {
        expect(nextCap(0, 1600)).toBe(1600);
        expect(nextCap(1600, 1080)).toBe(1080);
        expect(nextCap(1080, 1600)).toBe(1080);
    });
});
