import { describe, expect, it } from 'vitest';
import { buildDecoderConfig } from '../webCodecsConfig';

describe('buildDecoderConfig', () => {
    it('keeps Annex B SPS/PPS out of the avcC description field', () => {
        const configData = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1e, 0, 0, 0, 1, 0x68, 0xce]);
        const cfg = buildDecoderConfig({
            codec: 'avc1.42001E',
            detectedCodec: 'h264',
            codedWidth: 1280,
            codedHeight: 720,
            configData,
        });
        expect(cfg.codec).toBe('avc1.42001E');
        expect(cfg.codedWidth).toBe(1280);
        expect(cfg.codedHeight).toBe(720);
        expect(cfg.optimizeForLatency).toBe(true);
        expect(cfg.description).toBeUndefined();
    });

    it('keeps Annex B VPS/SPS/PPS out of the hvcC description field', () => {
        const configData = new Uint8Array([0, 0, 0, 1, 0x40, 0x01, 0, 0, 0, 1, 0x42, 0x01]);
        const cfg = buildDecoderConfig({
            codec: 'hev1.1.6.L93.B0',
            detectedCodec: 'h265',
            codedWidth: 1920,
            codedHeight: 1088,
            configData,
        });
        expect(cfg.description).toBeUndefined();
    });

    it('does NOT set a description for AV1 (config record is handled differently)', () => {
        const configData = new Uint8Array([0x81, 0x05, 0x0c, 0x00]);
        const cfg = buildDecoderConfig({
            codec: 'av01.0.04M.08',
            detectedCodec: 'av1',
            codedWidth: 1920,
            codedHeight: 1080,
            configData,
        });
        expect(cfg.description).toBeUndefined();
    });

});
