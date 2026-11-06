import { describe, expect, it } from 'vitest';
import { AUDIO_DISABLED, AUDIO_ERROR, CODEC_ID, codecName } from '../ScrcpyCodec';

describe('scrcpy 4.1 audio codec ids', () => {
    it('matches the documented four-byte audio ids and the disabled/error sentinels', () => {
        expect(CODEC_ID.OPUS).toBe(0x6f707573);
        expect(CODEC_ID.AAC).toBe(0x00616163);
        expect(CODEC_ID.RAW).toBe(0x00726177);
        expect(codecName(CODEC_ID.OPUS)).toBe('opus');
        expect(AUDIO_DISABLED).toBe(0);
        expect(AUDIO_ERROR).toBe(1);
        expect(codecName(AUDIO_DISABLED)).toBe('unknown(0x0)');
    });
});
