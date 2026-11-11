export const PCM_WORKLET_NAME = 'pcm-worklet';

export const PCM_WORKLET_SOURCE = `
class PcmWorkletProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._queue = [];
        this._queued = 0;
        // Start (and restart after an underrun) only with ~60 ms in hand so
        // network jitter is a rare gap instead of constant crackle.
        this._prebuffer = Math.round(sampleRate * 0.06);
        // Never fall more than ~250 ms behind the phone: drop the oldest audio.
        this._maxQueued = Math.round(sampleRate * 0.25);
        this._playing = false;
        this.port.onmessage = (e) => {
            const numFrames = e.data.numFrames | 0;
            if (numFrames <= 0) return;
            this._queue.push({
                channels: e.data.channels,
                numFrames,
                offset: 0,
            });
            this._queued += numFrames;
            while (this._queued > this._maxQueued && this._queue.length > 1) {
                const dropped = this._queue.shift();
                this._queued -= dropped.numFrames - dropped.offset;
            }
        };
    }

    process(inputs, outputs) {
        const output = outputs[0];
        if (!output || !output.length) return true;
        const frameCount = output[0].length;
        const outChannels = output.length;
        let written = 0;

        if (!this._playing && this._queued >= this._prebuffer) this._playing = true;

        while (this._playing && written < frameCount && this._queue.length > 0) {
            const block = this._queue[0];
            const remaining = block.numFrames - block.offset;
            const toWrite = Math.min(frameCount - written, remaining);

            for (let ch = 0; ch < outChannels; ch++) {
                const src = ch < block.channels.length ? block.channels[ch] : block.channels[0];
                output[ch].set(src.subarray(block.offset, block.offset + toWrite), written);
            }

            written += toWrite;
            block.offset += toWrite;
            this._queued -= toWrite;

            if (block.offset >= block.numFrames) {
                this._queue.shift();
            }
        }

        // Fill remaining with silence (underrun) and rebuild the cushion.
        if (written < frameCount) {
            if (this._playing && this._queue.length === 0) this._playing = false;
            for (let ch = 0; ch < outChannels; ch++) {
                output[ch].fill(0, written);
            }
        }

        return true;
    }
}

registerProcessor('${PCM_WORKLET_NAME}', PcmWorkletProcessor);
`;
