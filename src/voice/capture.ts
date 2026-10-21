// The audio thread's side of the microphone: its audio, at the device's
// rate, as 16-bit PCM at the rate Scribe hears, in chunks of 0.1 s.
import { Resampler } from "./resampler.ts";

// The AudioWorkletGlobalScope, which TypeScript's DOM types lack.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
	readonly port: MessagePort;
}
declare function registerProcessor(
	name: string,
	processor: new () => AudioWorkletProcessor,
): void;

const rate = 16_000;
const chunk = rate / 10;

class Capture extends AudioWorkletProcessor {
	private readonly resampler = new Resampler(sampleRate, rate);
	private pcm = new Int16Array(chunk);
	private filled = 0;

	process(inputs: Float32Array[][]): boolean {
		const input = inputs[0]?.[0];
		if (input === undefined) return true;
		for (const sample of this.resampler.push(input)) {
			this.pcm[this.filled++] = Math.round(
				Math.max(-1, Math.min(1, sample)) * 32767,
			);
			if (this.filled === chunk) {
				this.port.postMessage(this.pcm.buffer, [this.pcm.buffer]);
				this.pcm = new Int16Array(chunk);
				this.filled = 0;
			}
		}
		return true;
	}
}

registerProcessor("capture", Capture);
