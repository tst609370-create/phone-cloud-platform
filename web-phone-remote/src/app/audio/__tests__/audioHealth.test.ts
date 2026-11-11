import { describe, expect, it } from 'vitest';
import {
    AUDIO_NO_DATA_MS,
    AUDIO_SILENT_MS,
    REASON_GESTURE,
    REASON_NO_DATA,
    REASON_SILENT,
    audioProblem,
    browserAudioBlock,
    newAudioHealth,
    noteFrame,
    peakOf,
} from '../audioHealth';

describe('audioHealth', () => {
    it('stays quiet while audio is starting, then reports no data', () => {
        const s = newAudioHealth(0);
        expect(audioProblem(s, 1000)).toBeUndefined();
        expect(audioProblem(s, AUDIO_NO_DATA_MS)).toBe(REASON_NO_DATA);
    });

    it('reports a suspended AudioContext as needing a click', () => {
        const s = newAudioHealth(0);
        s.suspended = true;
        expect(audioProblem(s, 10)).toBe(REASON_GESTURE);
    });

    it('reports frames that are all silence', () => {
        const s = newAudioHealth(0);
        noteFrame(s, 100, 0);
        expect(audioProblem(s, 100 + AUDIO_SILENT_MS - 1)).toBeUndefined();
        expect(audioProblem(s, 100 + AUDIO_SILENT_MS)).toBe(REASON_SILENT);
        noteFrame(s, 9000, 0.2);
        expect(audioProblem(s, 20000)).toBeUndefined();
    });

    it('fatal reasons win', () => {
        const s = newAudioHealth(0);
        s.fatal = 'x';
        expect(audioProblem(s, 0)).toBe('x');
    });

    it('peakOf finds the loudest sample', () => {
        expect(peakOf([new Float32Array([0, -0.5]), new Float32Array([0.25])])).toBe(0.5);
    });

    it('explains missing browser decoders', () => {
        const env = { hasAudioContext: true, hasAudioDecoder: false, secure: false };
        expect(browserAudioBlock('raw', env)).toBeUndefined();
        expect(browserAudioBlock('opus', env)).toMatch(/http/);
        expect(browserAudioBlock('opus', { ...env, secure: true })).toMatch(/升级/);
        expect(browserAudioBlock('opus', { ...env, hasAudioDecoder: true })).toBeUndefined();
        expect(browserAudioBlock('raw', { ...env, hasAudioContext: false })).toMatch(/不支持/);
    });
});
