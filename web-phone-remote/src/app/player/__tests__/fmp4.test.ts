import { describe, expect, it } from 'vitest';
import { extractParams, initSegment, mediaSegment, mimeCodec, splitAnnexB, toAvccSample } from '../fmp4';

const CONFIG = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1e, 0x8c, 0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80]);

function boxAt(buf: Uint8Array, offset: number): { size: number; type: string } {
    const view = new DataView(buf.buffer, buf.byteOffset);
    return { size: view.getUint32(offset), type: String.fromCharCode(...buf.subarray(offset + 4, offset + 8)) };
}

describe('fmp4 muxer', () => {
    it('splits Annex B with 3- and 4-byte start codes', () => {
        const units = splitAnnexB(new Uint8Array([0, 0, 0, 1, 0x65, 1, 2, 0, 0, 1, 0x41, 3]));
        expect(units.map((u) => Array.from(u))).toEqual([[0x65, 1, 2], [0x41, 3]]);
    });

    it('builds avcC params and codec string from SPS/PPS', () => {
        const params = extractParams(CONFIG, 480, 1072)!;
        expect(mimeCodec(params)).toBe('avc1.42c01e');
        const init = initSegment(params);
        expect(boxAt(init, 0).type).toBe('ftyp');
        const moov = boxAt(init, boxAt(init, 0).size);
        expect(moov.type).toBe('moov');
        expect(boxAt(init, 0).size + moov.size).toBe(init.length);
    });

    it('drops parameter sets from samples and points trun at the mdat payload', () => {
        const sample = toAvccSample(new Uint8Array([...CONFIG, 0, 0, 0, 1, 0x65, 9, 9]));
        expect(Array.from(sample)).toEqual([0, 0, 0, 3, 0x65, 9, 9]);
        const seg = mediaSegment(1, 0, 3000, sample, true);
        const moof = boxAt(seg, 0);
        expect(moof.type).toBe('moof');
        const mdat = boxAt(seg, moof.size);
        expect(mdat.type).toBe('mdat');
        expect(moof.size + mdat.size).toBe(seg.length);
        // trun data_offset is the last-but-three field: find 'trun' and read it.
        const idx = Buffer.from(seg).indexOf('trun');
        const dataOffset = new DataView(seg.buffer).getUint32(idx + 4 + 4 + 4);
        expect(dataOffset).toBe(moof.size + 8);
        expect(Array.from(seg.subarray(dataOffset))).toEqual(Array.from(sample));
    });
});
