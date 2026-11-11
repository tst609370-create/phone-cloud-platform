/**
 * Minimal fragmented-MP4 muxer for H.264 (Annex B in, fMP4 out) so the
 * Media Source Extensions fallback can play scrcpy video where WebCodecs is
 * missing — e.g. http://<public IP>:port, which is not a secure context, so
 * `VideoDecoder` does not exist there.
 */
import { findFirstNaluOffset } from './naluScanner';

export const FMP4_TIMESCALE = 90000;

/** Split an Annex B buffer into NAL unit payloads (start codes removed). */
export function splitAnnexB(data: Uint8Array): Uint8Array[] {
    const units: Uint8Array[] = [];
    const starts: Array<{ start: number; payload: number }> = [];
    for (let i = 0; i + 2 < data.length; i++) {
        if (data[i] === 0 && data[i + 1] === 0) {
            if (data[i + 2] === 1) {
                starts.push({ start: i, payload: i + 3 });
                i += 2;
            } else if (data[i + 2] === 0 && i + 3 < data.length && data[i + 3] === 1) {
                starts.push({ start: i, payload: i + 4 });
                i += 3;
            }
        }
    }
    if (starts.length === 0) {
        if (findFirstNaluOffset(data) < 0 && data.length) units.push(data);
        return units;
    }
    for (let k = 0; k < starts.length; k++) {
        const end = k + 1 < starts.length ? starts[k + 1]!.start : data.length;
        const unit = data.subarray(starts[k]!.payload, end);
        if (unit.length) units.push(unit);
    }
    return units;
}

export interface AvcParams {
    sps: Uint8Array;
    pps: Uint8Array;
    width: number;
    height: number;
}

export function extractParams(config: Uint8Array, width: number, height: number): AvcParams | null {
    let sps: Uint8Array | undefined;
    let pps: Uint8Array | undefined;
    for (const unit of splitAnnexB(config)) {
        const type = unit[0]! & 0x1f;
        if (type === 7 && !sps) sps = unit;
        else if (type === 8 && !pps) pps = unit;
    }
    if (!sps || !pps || sps.length < 4) return null;
    return { sps, pps, width, height };
}

export function mimeCodec(params: AvcParams): string {
    const hex = (n: number) => n.toString(16).padStart(2, '0');
    return `avc1.${hex(params.sps[1]!)}${hex(params.sps[2]!)}${hex(params.sps[3]!)}`;
}

/** Annex B access unit → AVCC sample (4-byte lengths), parameter sets and AUDs dropped. */
export function toAvccSample(data: Uint8Array): Uint8Array {
    const units = splitAnnexB(data).filter((u) => {
        const type = u[0]! & 0x1f;
        return type !== 7 && type !== 8 && type !== 9;
    });
    let size = 0;
    for (const u of units) size += 4 + u.length;
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    let offset = 0;
    for (const u of units) {
        view.setUint32(offset, u.length);
        out.set(u, offset + 4);
        offset += 4 + u.length;
    }
    return out;
}

function box(type: string, ...payloads: Uint8Array[]): Uint8Array {
    let size = 8;
    for (const p of payloads) size += p.length;
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    view.setUint32(0, size);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let offset = 8;
    for (const p of payloads) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}

function bytes(...values: number[]): Uint8Array {
    return new Uint8Array(values);
}

function u32(value: number): Uint8Array {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value >>> 0);
    return out;
}

function u16(value: number): Uint8Array {
    return bytes((value >> 8) & 0xff, value & 0xff);
}

const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

function fullBox(type: string, version: number, flags: number, ...payloads: Uint8Array[]): Uint8Array {
    return box(type, bytes(version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff), ...payloads);
}

export function initSegment(params: AvcParams): Uint8Array {
    const { width, height, sps, pps } = params;
    const ftyp = box('ftyp', bytes(0x69, 0x73, 0x6f, 0x6d), u32(512), bytes(0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32, 0x61, 0x76, 0x63, 0x31, 0x6d, 0x70, 0x34, 0x31));
    const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(FMP4_TIMESCALE), u32(0), u32(0x00010000), u16(0x0100), new Uint8Array(10), ...MATRIX.map(u32), new Uint8Array(24), u32(2));
    const tkhd = fullBox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(0), new Uint8Array(8), u16(0), u16(0), u16(0), u16(0), ...MATRIX.map(u32), u32(width << 16), u32(height << 16));
    const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(FMP4_TIMESCALE), u32(0), u16(0x55c4), u16(0));
    const hdlr = fullBox('hdlr', 0, 0, u32(0), bytes(0x76, 0x69, 0x64, 0x65), new Uint8Array(12), bytes(0x56, 0x69, 0x64, 0x65, 0x6f, 0));
    const vmhd = fullBox('vmhd', 0, 1, new Uint8Array(8));
    const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
    const avcC = box('avcC', bytes(1, sps[1]!, sps[2]!, sps[3]!, 0xff, 0xe1), u16(sps.length), sps, bytes(1), u16(pps.length), pps);
    const avc1 = box(
        'avc1',
        new Uint8Array(6),
        u16(1),
        new Uint8Array(16),
        u16(width),
        u16(height),
        u32(0x00480000),
        u32(0x00480000),
        u32(0),
        u16(1),
        new Uint8Array(32),
        u16(0x0018),
        u16(0xffff),
        avcC,
    );
    const stbl = box(
        'stbl',
        fullBox('stsd', 0, 0, u32(1), avc1),
        fullBox('stts', 0, 0, u32(0)),
        fullBox('stsc', 0, 0, u32(0)),
        fullBox('stsz', 0, 0, u32(0), u32(0)),
        fullBox('stco', 0, 0, u32(0)),
    );
    const minf = box('minf', vmhd, dinf, stbl);
    const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
    const mvex = box('mvex', fullBox('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)));
    return concat(ftyp, box('moov', mvhd, trak, mvex));
}

/** One sample per fragment so each frame can be shown as soon as it arrives. */
export function mediaSegment(sequence: number, decodeTime: number, duration: number, sample: Uint8Array, key: boolean): Uint8Array {
    const flags = key ? 0x02000000 : 0x01010000;
    const tfhd = fullBox('tfhd', 0, 0x020000, u32(1));
    const tfdt = fullBox('tfdt', 1, 0, u32(Math.floor(decodeTime / 0x100000000)), u32(decodeTime >>> 0));
    // trun: data-offset, sample duration, size, flags present
    const trunPayloadSize = 4 + 4 + 12;
    const trunSize = 12 + trunPayloadSize;
    const mfhdSize = 16;
    const trafSize = 8 + 16 /* tfhd */ + 20 /* tfdt v1 */ + trunSize;
    const moofSize = 8 + mfhdSize + trafSize;
    const trun = fullBox('trun', 0, 0x000701, u32(1), u32(moofSize + 8), u32(duration), u32(sample.length), u32(flags));
    const moof = box('moof', fullBox('mfhd', 0, 0, u32(sequence)), box('traf', tfhd, tfdt, trun));
    return concat(moof, box('mdat', sample));
}

function concat(...parts: Uint8Array[]): Uint8Array {
    let size = 0;
    for (const p of parts) size += p.length;
    const out = new Uint8Array(size);
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}
