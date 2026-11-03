// The audio thread's side of the page's audio, where it resamples, which
// would take the page's own thread too long on a slow phone. `capture` hands
// the microphone's audio on at the rate voice hears, `LISTEN_RATE`, in chunks
// of 0.1 s. `playback` plays what the page renders at `SPEECH_RATE`, which it
// asks for as it plays, keeping a little ahead, so that the device's clock is
// the one voice plays by.
import { LISTEN_RATE, Resampler, SPEECH_RATE } from "voice-core";

// The AudioWorkletGlobalScope, which TypeScript's DOM types lack.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
	readonly port: MessagePort;
}
declare function registerProcessor(
	name: string,
	processor: new () => AudioWorkletProcessor,
): void;

const CHUNK = LISTEN_RATE / 10;

class Capture extends AudioWorkletProcessor {
	private readonly resampler = new Resampler(sampleRate, LISTEN_RATE);
	private pcm = new Float32Array(CHUNK);
	private filled = 0;

	process(inputs: Float32Array[][]): boolean {
		const input = inputs[0]?.[0];
		if (input === undefined) return true;
		for (const sample of this.resampler.push(input)) {
			this.pcm[this.filled++] = sample;
			if (this.filled === CHUNK) {
				this.port.postMessage(this.pcm.buffer, [this.pcm.buffer]);
				this.pcm = new Float32Array(CHUNK);
				this.filled = 0;
			}
		}
		return true;
	}
}

/** How far ahead playback keeps what it is to play, in seconds, and how
 * much it asks for at once. What it holds beyond `KEEP` it drops whenever
 * the page asks, as what is to play changes, so that a change is heard
 * within `KEEP`, and the rest only guards against the page's thread being
 * late. */
const AHEAD = 0.15;
const BLOCK = Math.round(0.02 * SPEECH_RATE);
/** What it keeps as it drops, in samples at `SPEECH_RATE`: what plays while
 * the page's thread renders anew, and so how late a change is heard. */
const KEEP = Math.round(0.05 * SPEECH_RATE);

/** What playback tells the page: that it needs a block, with how much it
 * played in all; how much it dropped as asked; how much it lacked in all. */
export type FromPlayback =
	| { need: number; played: number }
	| { dropped: number }
	| { short: number };

class Playback extends AudioWorkletProcessor {
	private readonly resampler = new Resampler(SPEECH_RATE, sampleRate);
	/** What is still to play, at `SPEECH_RATE`, the first from `at` on. */
	private queue: Float32Array[] = [];
	private at = 0;
	/** What was resampled and not yet played, at the device's rate. */
	private ahead = new Float32Array(0);
	/** Samples at `SPEECH_RATE` queued, asked for but not yet given, and
	 * played in all. */
	private queued = 0;
	private asked = 0;
	private played = 0;
	/** Samples it had nothing to play for, once it had something. */
	private short = 0;
	private started = false;

	constructor() {
		super();
		this.port.onmessage = ({ data }: MessageEvent<ArrayBuffer | "drop">) => {
			if (data === "drop") {
				// The next samples stay, for the page's thread to render anew
				// behind them before they run out, rather than leave a gap.
				const kept = this.take(Math.min(KEEP, this.queued));
				this.played -= kept.length;
				const dropped = this.queued;
				this.queue = [kept];
				this.at = 0;
				this.queued = kept.length;
				this.port.postMessage({ dropped } satisfies FromPlayback);
				return;
			}
			const speech = new Float32Array(data);
			this.asked -= speech.length;
			this.queued += speech.length;
			this.queue.push(speech);
			this.started = true;
		};
	}

	/** Up to `count` samples of the queue, at `SPEECH_RATE`. */
	private take(count: number): Float32Array {
		const taken = new Float32Array(Math.min(count, this.queued));
		let i = 0;
		while (i < taken.length) {
			const first = this.queue[0] as Float32Array;
			const n = Math.min(taken.length - i, first.length - this.at);
			taken.set(first.subarray(this.at, this.at + n), i);
			i += n;
			this.at += n;
			if (this.at === first.length) {
				this.queue.shift();
				this.at = 0;
			}
		}
		this.queued -= taken.length;
		this.played += taken.length;
		return taken;
	}

	process(_: Float32Array[][], outputs: Float32Array[][]): boolean {
		const out = outputs[0]?.[0];
		if (out === undefined) return true;
		while (this.ahead.length < out.length && this.queued > 0) {
			const missing = out.length - this.ahead.length;
			const made = this.resampler.push(
				this.take(Math.ceil((missing * SPEECH_RATE) / sampleRate) + 1),
			);
			const ahead = new Float32Array(this.ahead.length + made.length);
			ahead.set(this.ahead);
			ahead.set(made, this.ahead.length);
			this.ahead = ahead;
		}
		const n = Math.min(out.length, this.ahead.length);
		out.set(this.ahead.subarray(0, n));
		this.ahead = this.ahead.slice(n);
		if (n < out.length && this.started) {
			this.short += out.length - n;
			this.port.postMessage({ short: this.short } satisfies FromPlayback);
		}
		while (this.queued + this.asked + BLOCK <= AHEAD * SPEECH_RATE) {
			this.asked += BLOCK;
			this.port.postMessage({
				need: BLOCK,
				played: this.played,
			} satisfies FromPlayback);
		}
		return true;
	}
}

registerProcessor("capture", Capture);
registerProcessor("playback", Playback);
