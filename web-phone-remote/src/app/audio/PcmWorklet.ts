export const PCM_WORKLET_NAME = 'pcm-worklet';

export const PCM_WORKLET_SOURCE = `
class PcmWorkletProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._queue = [];
        this.port.onmessage = (e) => {
            this._queue.push({
                channels: e.data.channels,
                numFrames: e.data.numFrames,
                offset: 0,
            });
        };
    }

    process(inputs, outputs) {
        const output = outputs[0];
        if (!output || !output.length) return true;
        const frameCount = output[0].length;
        const outChannels = output.length;
        let written = 0;

        while (written < frameCount && this._queue.length > 0) {
            const block = this._queue[0];
            const remaining = block.numFrames - block.offset;
            const toWrite = Math.min(frameCount - written, remaining);

            for (let ch = 0; ch < outChannels; ch++) {
                const src = ch < block.channels.length ? block.channels[ch] : block.channels[0];
                output[ch].set(src.subarray(block.offset, block.offset + toWrite), written);
            }

            written += toWrite;
            block.offset += toWrite;

            if (block.offset >= block.numFrames) {
                this._queue.shift();
            }
        }

        // Fill remaining with silence (underrun)
        if (written < frameCount) {
            for (let ch = 0; ch < outChannels; ch++) {
                output[ch].fill(0, written);
            }
        }

        return true;
    }
}

registerProcessor('${PCM_WORKLET_NAME}', PcmWorkletProcessor);
`;
