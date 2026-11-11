import { describe, expect, it } from 'vitest';
import { VideoBackpressure } from '../videoBackpressure';

describe('VideoBackpressure', () => {
    const opts = { highWater: 1000, lowWater: 200, resetIntervalMs: 1000 };

    it('sends everything while the network keeps up', () => {
        const bp = new VideoBackpressure(opts);
        expect(bp.video('keyframe', 0, 0).send).toBe(true);
        expect(bp.video('delta', 900, 1).send).toBe(true);
        expect(bp.droppedFrames).toBe(0);
    });

    it('skips delta frames once backlogged and resumes only on a keyframe after draining', () => {
        const bp = new VideoBackpressure(opts);
        expect(bp.video('delta', 1500, 0).send).toBe(false);
        expect(bp.isDropping).toBe(true);
        // still backlogged: even a keyframe is skipped, no reset yet
        expect(bp.video('keyframe', 800, 10)).toEqual({ send: false, requestKeyframe: false });
        // drained: ask for a keyframe once, throttled
        expect(bp.video('delta', 100, 20)).toEqual({ send: false, requestKeyframe: true });
        expect(bp.video('delta', 100, 30)).toEqual({ send: false, requestKeyframe: false });
        expect(bp.video('delta', 100, 1100)).toEqual({ send: false, requestKeyframe: true });
        // config always passes, keyframe resumes
        expect(bp.video('config', 5000, 1200).send).toBe(true);
        expect(bp.video('keyframe', 100, 1300).send).toBe(true);
        expect(bp.isDropping).toBe(false);
        expect(bp.video('delta', 100, 1301).send).toBe(true);
    });

    it('drops audio only far beyond the video threshold', () => {
        const bp = new VideoBackpressure(opts);
        expect(bp.audio(1500)).toBe(true);
        expect(bp.audio(2500)).toBe(false);
    });
});
