import { describe, expect, it } from 'vitest';
import { bytesToS16le, PcmResampler, s16leToBytes } from '../resample';

describe('PcmResampler', () => {
    it('copies samples when the rates match', () => {
        const resampler = new PcmResampler(48000, 48000);
        const input = Int16Array.of(1, -2, 3);
        expect(Array.from(resampler.process(input))).toEqual([1, -2, 3]);
    });

    it('downsamples 2:1 across chunk boundaries', () => {
        const resampler = new PcmResampler(2000, 1000);
        const first = resampler.process(Int16Array.of(0, 10, 20, 30));
        const second = resampler.process(Int16Array.of(40, 50, 60, 70));
        expect(first.length + second.length).toBeGreaterThan(0);
        expect(first.length).toBeLessThan(4);
        const all = [...first, ...second];
        expect(all.every((sample) => sample >= 0 && sample <= 70)).toBe(true);
    });

    it('round-trips s16le bytes', () => {
        const samples = Int16Array.of(0, -1, 32767, -32768);
        expect(Array.from(bytesToS16le(s16leToBytes(samples)))).toEqual([0, -1, 32767, -32768]);
    });
});
