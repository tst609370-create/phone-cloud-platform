/**
 * Stateful linear resampler for the browser → 48 kHz hop.
 * Keeps the fractional source position so chunk boundaries do not click.
 */

const MIN = -32768;
const MAX = 32767;

export function clamp16(sample: number): number {
    const rounded = Math.round(sample);
    if (rounded < MIN) return MIN;
    if (rounded > MAX) return MAX;
    return rounded;
}

export function bytesToS16le(bytes: Uint8Array): Int16Array {
    const n = bytes.byteLength - (bytes.byteLength % 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset, n);
    const out = new Int16Array(n / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = view.getInt16(i * 2, true);
    }
    return out;
}

export function s16leToBytes(samples: Int16Array): Uint8Array {
    const out = new Uint8Array(samples.length * 2);
    const view = new DataView(out.buffer);
    for (let i = 0; i < samples.length; i++) {
        view.setInt16(i * 2, samples[i] ?? 0, true);
    }
    return out;
}

export class PcmResampler {
    /** Next output's source position. 0 is the first sample of the next chunk; negative indexes `prev`. */
    private pos = 0;
    private prev = 0;

    constructor(
        private fromRate: number,
        private readonly toRate: number,
    ) {}

    setInputRate(rate: number): void {
        if (rate === this.fromRate || !Number.isFinite(rate) || rate <= 0) return;
        this.fromRate = rate;
        this.pos = 0;
    }

    process(input: Int16Array): Int16Array {
        if (input.length === 0) return new Int16Array(0);
        if (this.fromRate === this.toRate) {
            this.prev = input[input.length - 1] ?? this.prev;
            this.pos = 0;
            return input;
        }
        const step = this.fromRate / this.toRate;
        const out: number[] = [];
        let pos = this.pos;
        while (pos < input.length) {
            const i0 = Math.floor(pos);
            const frac = pos - i0;
            if (frac === 0 && i0 >= 0 && i0 < input.length) {
                out.push(input[i0] ?? 0);
                pos += step;
                continue;
            }
            const i1 = i0 + 1;
            if (i1 >= input.length || i0 >= input.length) break;
            const s0 = i0 < 0 ? this.prev : (input[i0] ?? 0);
            const s1 = input[i1] ?? 0;
            out.push(clamp16(s0 * (1 - frac) + s1 * frac));
            pos += step;
        }
        this.prev = input[input.length - 1] ?? this.prev;
        this.pos = pos - input.length;
        return Int16Array.from(out);
    }
}

/** Resample `input` so the result has exactly `outputLength` samples. */
export function resampleToLength(input: Int16Array, outputLength: number): Int16Array {
    const out = new Int16Array(Math.max(0, outputLength));
    if (out.length === 0) return out;
    if (input.length === 0) return out;
    if (input.length === 1 || out.length === 1) {
        out.fill(input[0] ?? 0);
        return out;
    }
    const scale = (input.length - 1) / (out.length - 1);
    for (let i = 0; i < out.length; i++) {
        const pos = i * scale;
        const i0 = Math.floor(pos);
        const i1 = Math.min(i0 + 1, input.length - 1);
        const frac = pos - i0;
        const s0 = input[i0] ?? 0;
        const s1 = input[i1] ?? 0;
        out[i] = clamp16(s0 * (1 - frac) + s1 * frac);
    }
    return out;
}
