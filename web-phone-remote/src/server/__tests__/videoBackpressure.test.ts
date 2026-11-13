import { describe, expect, it } from 'vitest';
import { ackedThresholds, StreamNetMeter, VideoBackpressure } from '../videoBackpressure';

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

    it('counts each fall-behind once and asks for a keyframe as soon as an ACK shows the backlog drained', () => {
        const bp = new VideoBackpressure(opts);
        bp.video('delta', 1500, 0);
        bp.video('delta', 1600, 5);
        expect(bp.episodes).toBe(1);
        expect(bp.drained(500, 10)).toBe(false);
        expect(bp.drained(100, 20)).toBe(true);
        expect(bp.drained(100, 30)).toBe(false); // throttled
        bp.video('keyframe', 100, 40);
        expect(bp.drained(0, 5000)).toBe(false); // not dropping any more
    });
});

describe('ackedThresholds', () => {
    it('scales with bitrate but keeps floors for one keyframe + a round trip', () => {
        expect(ackedThresholds(2_000_000)).toEqual({ highWater: 192 * 1024, lowWater: 64 * 1024 });
        const hi = ackedThresholds(8_000_000);
        expect(hi.highWater).toBe(450_000);
        expect(hi.lowWater).toBe(150_000);
        expect(ackedThresholds(undefined).highWater).toBeLessThan(1024 * 1024);
    });
});

describe('StreamNetMeter', () => {
    it('tracks in-flight bytes, round trip and delivered rate from browser ACKs', () => {
        const m = new StreamNetMeter();
        m.onSent(100_000);
        m.onSent(50_000);
        expect(m.inflight).toBe(150_000);
        m.tick(1000, false);
        m.onAck(125_000, 0, 1200);
        expect(m.ackSeen).toBe(true);
        expect(m.inflight).toBe(25_000);
        expect(m.rttMs).toBe(-1);
        m.onAck(150_000, 1500, 1740);
        expect(m.rttMs).toBe(240);
        // stale / bogus acks never move the counter backwards or past what was sent
        m.onAck(10, 0, 1800);
        m.onAck(999_999, 0, 1800);
        expect(m.ackedBytes).toBe(150_000);
        m.tick(2000, true);
        expect(m.goodputKbps).toBe(1200);
        expect(m.capacityKbps).toBe(1200);
    });
});
