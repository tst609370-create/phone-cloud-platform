// src/common/ChannelId.ts
export enum ChannelId {
    VIDEO = 0,
    AUDIO = 1,
    CONTROL = 2,
    DEVICE_MSG = 3,
    METADATA = 4,
    /** server → browser, JSON {@link StreamNetStats}, about once a second. */
    STATS = 5,
    /**
     * browser → server: Float64 total video bytes received + Float64 echo of
     * the last STATS `t`. Sent for every video frame so the server knows how
     * much is really still in flight (frpc/QUIC/kernel buffers included).
     */
    ACK = 6,
}

/** What the server reports on {@link ChannelId.STATS}. */
export interface StreamNetStats {
    /** Server clock (ms); the browser echoes it back in the next ACK. */
    t: number;
    /** Round trip measured through the video queue (ms), -1 until known. */
    rttMs: number;
    /** Video bytes sent but not yet acknowledged by the browser. */
    inflight: number;
    /** Video actually delivered to the browser over the last second (kbit/s). */
    goodputKbps: number;
    /** Encoder target bitrate (bit/s). */
    bitrate: number;
    /** Frames skipped so far because the network fell behind. */
    dropped: number;
    /** How many times the network fell behind (each = a skip-to-keyframe). */
    episodes: number;
    /** Delivered rate while the network was behind = what the link can carry (kbit/s), 0 if never behind. */
    capacityKbps: number;
}
