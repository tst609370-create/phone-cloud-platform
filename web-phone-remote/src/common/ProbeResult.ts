import type { MicCapability } from './micProtocol';

export interface ProbeResult {
    width: number;
    height: number;
    density: number;
    sdkInt: number;
    videoEncoders: string[];
    audioEncoders: string[];
    /** Virtual-mic routes. Omitted only by servers that predate the feature. */
    mic?: MicCapability;
}
