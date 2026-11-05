import { describe, expect, it } from 'vitest';
import { downmixToMono, floatToS16le } from '../floatToS16le';

describe('floatToS16le', () => {
    it('maps full scale and averages stereo to mono', () => {
        const pcm = floatToS16le(Float32Array.of(0, 1, -1, 0.5));
        expect(Array.from(pcm)).toEqual([0, 32767, -32768, Math.round(0.5 * 32767)]);
        const mono = downmixToMono([Float32Array.of(0, 1), Float32Array.of(1, 1)], 2);
        expect(Array.from(mono)).toEqual([0.5, 1]);
    });
});
