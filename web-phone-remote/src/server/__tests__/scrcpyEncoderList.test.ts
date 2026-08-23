import { describe, expect, it } from 'vitest';
import { parseScrcpyEncoderList } from '../scrcpyEncoderList';

describe('parseScrcpyEncoderList', () => {
    it('parses OMX-style output (Android 7.1.1 SM-T550)', () => {
        const output = `[server] INFO: Device: [samsung] samsung SM-T550 (Android 7.1.1)
[server] INFO: List of video encoders:
    --video-codec=h264 --video-encoder=OMX.qcom.video.encoder.avc
    --video-codec=h264 --video-encoder=OMX.google.h264.encoder
[server] INFO: List of audio encoders:
    --audio-codec=aac --audio-encoder=OMX.google.aac.encoder
    --audio-codec=aac --audio-encoder=OMX.SEC.naac.enc
    --audio-codec=flac --audio-encoder=OMX.google.flac.encoder
`;
        expect(parseScrcpyEncoderList(output)).toEqual({
            videoEncoders: ['OMX.qcom.video.encoder.avc', 'OMX.google.h264.encoder'],
            audioEncoders: ['OMX.google.aac.encoder', 'OMX.SEC.naac.enc', 'OMX.google.flac.encoder'],
        });
    });

    it('parses codec2-style output with hw/sw annotations (Android 10+)', () => {
        const output = `[server] INFO: List of video encoders:
    --video-codec=h264 --video-encoder=c2.qti.avc.encoder     (hw) [vendor]
    --video-codec=h264 --video-encoder=c2.android.avc.encoder (sw)
    --video-codec=h265 --video-encoder=c2.mtk.hevc.encoder    (hw) [vendor] (alias for OMX.MTK.VIDEO.ENCODER.HEVC)
[server] INFO: List of audio encoders:
    --audio-codec=opus --audio-encoder=c2.android.opus.encoder (sw)
`;
        expect(parseScrcpyEncoderList(output)).toEqual({
            videoEncoders: ['c2.qti.avc.encoder', 'c2.android.avc.encoder', 'c2.mtk.hevc.encoder'],
            audioEncoders: ['c2.android.opus.encoder'],
        });
    });

    it('returns empty arrays for output without encoder lines', () => {
        expect(parseScrcpyEncoderList('')).toEqual({ videoEncoders: [], audioEncoders: [] });
        expect(parseScrcpyEncoderList('garbage output no encoders here')).toEqual({
            videoEncoders: [],
            audioEncoders: [],
        });
    });

    it('preserves original order (first-occurrence)', () => {
        const output = `    --video-codec=h264 --video-encoder=first
    --video-codec=h264 --video-encoder=second
    --video-codec=h265 --video-encoder=third`;
        expect(parseScrcpyEncoderList(output).videoEncoders).toEqual(['first', 'second', 'third']);
    });
});
