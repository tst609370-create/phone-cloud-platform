/** Convert mono float samples in [-1, 1] to little-endian PCM s16. */
export function floatToS16le(input: Float32Array): Int16Array {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
        const clamped = Math.max(-1, Math.min(1, input[i] ?? 0));
        out[i] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    }
    return out;
}

export function downmixToMono(channels: ArrayLike<Float32Array>, frameCount: number): Float32Array {
    const out = new Float32Array(frameCount);
    if (channels.length === 0) return out;
    const first = channels[0];
    if (!first) return out;
    if (channels.length === 1) {
        out.set(first.subarray(0, frameCount));
        return out;
    }
    for (let i = 0; i < frameCount; i++) {
        let sum = 0;
        for (let c = 0; c < channels.length; c++) {
            sum += channels[c]?.[i] ?? 0;
        }
        out[i] = sum / channels.length;
    }
    return out;
}
