// Turn detection, from the microphone's audio at 16 kHz and the words heard
// so far: voice activity marks the pauses, and through each pause the turn
// detector judges whether the person sounds finished, as `Patience` sets
// out. The models come from outside, so that it runs anywhere.

const RATE = 16_000;

/** Silero's window, and the context of the window before it hears with it. */
export const WINDOW = 512;
export const CONTEXT = 64;

/** How patient turn detection is, in seconds. */
export type Patience = {
	/** How long a pause lasts before the turn detector may end the turn. */
	settle: number;
	/** How sure the turn detector has to be that the turn is finished. */
	confidence: number;
	/** How long a pause lasts before a turn whose words so far sound finished
	 * ends, whatever the turn detector says. */
	textSettle: number;
	/** The silence that ends a turn the turn detector does not. */
	wait: number;
};

/** Weighed on Luis's real use, in the research log of voice's design. */
export const PATIENCE: Patience = {
	settle: 0.75,
	confidence: 0.8,
	textSettle: 1.5,
	wait: 3,
};

export type Models = {
	/** How likely a window of `CONTEXT + WINDOW` samples is speech, given
	 * the model's state after the windows before, which it updates. */
	voiced(window: Float32Array, state: Float32Array): Promise<number>;
	/** The model's state before any window. */
	initial(): Float32Array;
	/** How likely the last 8 s of a turn's audio sound finished. */
	finished(turn: Float32Array): Promise<number>;
};

export type TurnEvent =
	| { type: "speech"; at: number }
	| { type: "silence"; at: number }
	| { type: "verdict"; probability: number; paused: number }
	| { type: "ended"; reason: "complete" | "text" | "wait" };

/** Voice activity's hysteresis: speech starts above `THRESHOLD`, and ends
 * after `PAUSE` below `NEGATIVE`, as Silero's own iterator judges. */
const THRESHOLD = 0.5;
const NEGATIVE = 0.35;
/** The silence that counts as a pause. */
const PAUSE = 0.2 * RATE;
/** How far speech's start and end move outward. */
const PADDING = 0.1 * RATE;
/** How often the turn detector judges a pause past the settle. */
const JUDGING = 0.25 * RATE;
/** The longest stretch of a pause inside a turn that the turn detector
 * hears, so that its verdict does not depend on how long the person paused. */
const GAP = 0.3 * RATE;

export class Turns {
	private readonly models: Models;
	private readonly patience: Patience;
	private state: Float32Array;
	/** The window before the next, its last `CONTEXT` samples heard with it. */
	private context = new Float32Array(CONTEXT);
	/** Input not yet filling a window. */
	private pending: number[] = [];
	/** Recent input, from the absolute sample `offset`. */
	private recent = new Float32Array(16 * RATE);
	private length = 0;
	private offset = 0;
	private triggered = false;
	/** Where the silence started that may end speech. */
	private quiet: number | null = null;
	/** Where the turn in progress starts, if one is. */
	private start: number | null = null;
	/** Where its speech last ended, while the person is silent. */
	private silence: number | null = null;
	/** Where the turn detector last judged the pause. */
	private judged: number | null = null;
	/** The words heard of the turn in progress so far. */
	private text = "";

	constructor(models: Models, patience = PATIENCE) {
		this.models = models;
		this.patience = patience;
		this.state = models.initial();
	}

	/** Whether a turn is in progress. */
	get turn(): boolean {
		return this.start !== null;
	}

	/** Takes input, and returns what it marks. */
	async feed(samples: Float32Array): Promise<TurnEvent[]> {
		const events: TurnEvent[] = [];
		for (const sample of samples) this.pending.push(sample);
		while (this.pending.length >= WINDOW) {
			const window = Float32Array.from(this.pending.splice(0, WINDOW));
			this.keep(window);
			const input = new Float32Array(CONTEXT + WINDOW);
			input.set(this.context);
			input.set(window, CONTEXT);
			this.context = input.slice(WINDOW);
			const probability = await this.models.voiced(input, this.state);
			await this.step(probability, events);
		}
		return events;
	}

	/** The words heard of the turn in progress so far, as they come. */
	transcribed(text: string): void {
		if (this.start !== null) this.text = text;
	}

	/** Ends the turn in progress, if one is, as the person did by hand:
	 * speech still going on starts the next. */
	end(): void {
		this.start = this.triggered ? this.now() : null;
		this.silence = null;
		this.judged = null;
		this.text = "";
	}

	private now(): number {
		return this.offset + this.length;
	}

	private async step(probability: number, events: TurnEvent[]): Promise<void> {
		const now = this.now();
		if (probability >= THRESHOLD) {
			this.quiet = null;
			if (!this.triggered) {
				this.triggered = true;
				const at = Math.max(this.offset, now - WINDOW - PADDING);
				this.start ??= at;
				this.silence = null;
				this.judged = null;
				events.push({ type: "speech", at: at / RATE });
			}
		} else if (probability < NEGATIVE && this.triggered) {
			this.quiet ??= now - WINDOW;
			if (now - this.quiet >= PAUSE) {
				this.triggered = false;
				this.silence = Math.min(now, this.quiet + PADDING);
				this.quiet = null;
				events.push({ type: "silence", at: this.silence / RATE });
			}
		}
		if (this.silence === null || this.start === null) return this.trim();
		const paused = (now - this.silence) / RATE;
		const { settle, confidence, textSettle, wait } = this.patience;
		if (paused >= wait) return this.ended("wait", events);
		if (
			paused >= settle &&
			(this.judged === null || now - this.judged >= JUDGING)
		) {
			this.judged = now;
			const audio = this.recent.subarray(
				this.start - this.offset,
				this.silence - this.offset,
			);
			const probability = await this.models.finished(
				closingSilences(audio, GAP),
			);
			events.push({ type: "verdict", probability, paused });
			if (probability > confidence) return this.ended("complete", events);
		}
		if (paused >= textSettle && finished(this.text))
			return this.ended("text", events);
	}

	private ended(reason: "complete" | "text" | "wait", events: TurnEvent[]) {
		this.end();
		events.push({ type: "ended", reason });
		this.trim();
	}

	private keep(window: Float32Array): void {
		if (this.length + window.length > this.recent.length) {
			const recent = new Float32Array(2 * (this.length + window.length));
			recent.set(this.recent.subarray(0, this.length));
			this.recent = recent;
		}
		this.recent.set(window, this.length);
		this.length += window.length;
	}

	/** Keeps the turn in progress, or else a second, for the padding before
	 * the next one. */
	private trim(): void {
		const from = this.start ?? Math.max(this.offset, this.now() - RATE);
		const drop = from - this.offset;
		if (drop < RATE) return;
		this.recent.copyWithin(0, drop, this.length);
		this.length -= drop;
		this.offset += drop;
	}
}

/**
 * `samples` with each silence inside cut to `gap` samples around its
 * middle, where a silence at the end stays whole. Silence is a 10 ms frame
 * far quieter than the loudest one.
 */
export function closingSilences(
	samples: Float32Array,
	gap: number,
): Float32Array {
	const frame = RATE / 100;
	const count = Math.ceil(samples.length / frame);
	const levels = new Float32Array(count);
	let loudest = 0;
	for (let f = 0; f < count; f++) {
		const slice = samples.subarray(f * frame, (f + 1) * frame);
		let sum = 0;
		for (const s of slice) sum += s * s;
		levels[f] = Math.sqrt(sum / slice.length);
		loudest = Math.max(loudest, levels[f] ?? 0);
	}
	const floor = Math.max(loudest * 0.02, 0.002);
	const kept = Math.floor(gap / frame);
	const spans: Float32Array[] = [];
	const span = (from: number, to: number) =>
		spans.push(samples.subarray(from * frame, to * frame));
	let index = 0;
	while (index < count) {
		let end = index;
		while (end < count && (levels[end] ?? 0) < floor) end++;
		if (end - index > kept && end < count) {
			span(index, index + Math.floor(kept / 2));
			span(end - (kept - Math.floor(kept / 2)), end);
			index = end;
		} else {
			const next = Math.max(end, index + 1);
			span(index, next);
			index = next;
		}
	}
	const result = new Float32Array(spans.reduce((n, s) => n + s.length, 0));
	let at = 0;
	for (const s of spans) {
		result.set(s, at);
		at += s.length;
	}
	return result;
}

/**
 * Whether the words sound finished: they end a sentence, and not on a filler
 * or a conjunction, after which the person goes on. The turn detector hears
 * only the voice, and the transcriber punctuates by the words.
 */
export function finished(text: string): boolean {
	const words = text.trim();
	if (!/[.?!]["'”’)]*$/.test(words)) return false;
	const last = words
		.split(/[^\p{L}'-]+/u)
		.findLast((word) => /\p{L}/u.test(word));
	return last !== undefined && !TRAILING.has(last.toLowerCase());
}

/** Words a sentence the person goes on after may end on. */
const TRAILING = new Set([
	"um",
	"uh",
	"hmm",
	"and",
	"but",
	"so",
	"or",
	"because",
	"like",
]);
