import { describe, expect, it } from 'vitest';
import { PCM_WORKLET_SOURCE } from '../PcmWorklet';

type Proc = { port: { onmessage: (e: { data: unknown }) => void }; process(i: unknown, o: Float32Array[][]): boolean };

function load(rate = 48000): Proc {
    let Ctor: (new () => Proc) | undefined;
    class Base {
        port = { onmessage: (_e: { data: unknown }) => undefined };
    }
    new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', PCM_WORKLET_SOURCE)(
        Base,
        (_name: string, ctor: new () => Proc) => {
            Ctor = ctor;
        },
        rate,
    );
    return new Ctor!();
}

function push(p: Proc, frames: number, value: number): void {
    const ch = new Float32Array(frames).fill(value);
    p.port.onmessage({ data: { channels: [ch, ch], numFrames: frames } });
}

function render(p: Proc): Float32Array {
    const out = [new Float32Array(128), new Float32Array(128)];
    p.process([], [out]);
    return out[0]!;
}

describe('pcm playback worklet', () => {
    it('stays silent until ~60 ms is buffered, then plays', () => {
        const p = load();
        push(p, 1000, 0.5);
        expect(render(p)[0]).toBe(0);
        push(p, 2000, 0.5);
        expect(render(p)[0]).toBeCloseTo(0.5);
    });

    it('drops the oldest audio instead of drifting behind', () => {
        const p = load();
        for (let i = 0; i < 20; i++) push(p, 960, 0.1); // 400 ms of old audio
        push(p, 960, 0.9);
        // at most ~250 ms is kept, so the newest block is reached within 250 ms of output
        let heard = false;
        for (let i = 0; i < Math.ceil((48000 * 0.25) / 128) + 1 && !heard; i++) heard = (render(p)[0] ?? 0) > 0.5;
        expect(heard).toBe(true);
    });
});
