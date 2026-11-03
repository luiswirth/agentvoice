// The speech the speaker plays: lines of it at `SPEECH_RATE`, each behind the
// one before, rendered as the host pulls what to play. The host may hold what
// it pulled for a while before it plays it, and tells how much it played:
// what was heard, whether it sounds, and which line plays follow that, never
// what was only rendered. What the host holds, it drops at once when what is
// to play changes, as on a pause, a duck or new speech after silence: the
// player takes it back and renders it anew, so that a change is heard at
// once whatever the host holds.
import { Resampler } from "./resampler.ts";
import { SPEECH_RATE } from "./tier.ts";

/** The volume speech plays at while the person may be starting to talk. */
const DUCKED = 0.25;
/** How fast the volume follows a duck, as a time constant in seconds. */
const DUCKING = 0.03;
/** How many of the last samples played `level` hears. */
const LEVEL = 512;

/** A stretch of a line's speech, where it starts in the line, in seconds,
 * and how much of it was rendered, in samples. */
type Stretch = {
	line: number;
	from: number;
	samples: Float32Array;
	at: number;
};

/** A run of what was rendered, from sample `start` of all: a stretch's
 * samples from `at` on, or silence. */
type Run = {
	start: number;
	length: number;
	stretch: Stretch | null;
	at: number;
	/** The rendered samples, as `level` hears them. */
	samples: Float32Array;
};

export class Player {
	/** What is still to render, the first perhaps begun. */
	private queue: Stretch[] = [];
	/** What was rendered and may not be played yet, in order. */
	private runs: Run[] = [];
	/** Samples rendered in all, and played in all, at `SPEECH_RATE`. */
	private rendered = 0;
	private sounded = 0;
	private paused = false;
	private gain = 1;
	private target = 1;
	/** Lines stopped, which nothing takes back. */
	private readonly stopped = new Set<number>();
	/** How far each line played, in seconds. */
	private readonly progressOf = new Map<number, number>();
	/** Whether the last render ran out of speech while not paused, so that
	 * speech that comes now would wait behind silence. */
	private starved = true;
	/** Resamples to the host's rate, with what it made ahead. */
	private resampler: { rate: number; resampler: Resampler | null } | null =
		null;
	private ahead = new Float32Array(0);
	/** The line playing, or else the next to, as last told. */
	head: number | null = null;
	/** Called as `head` changes, with none once nothing is left. */
	changed: (line: number | null) => void = () => {};
	/** Called as what is to play changes, for the host to drop what it holds
	 * and give it back with `unrender`. */
	flush: () => void = () => {};

	/** How loud it plays now, from 0 to 1, scaled as the microphone's level. */
	level(): number {
		let sum = 0;
		let count = 0;
		for (let i = this.runs.length - 1; i >= 0 && count < LEVEL; i--) {
			const run = this.runs[i] as Run;
			if (run.start >= this.sounded) continue;
			const end = Math.min(run.length, this.sounded - run.start);
			for (let j = end - 1; j >= 0 && count < LEVEL; j--, count++)
				sum += (run.samples[j] ?? 0) ** 2;
		}
		return Math.min(1, Math.sqrt(sum / LEVEL) * 8);
	}

	/** Plays on quieter, or at full volume again. */
	duck(ducked: boolean): void {
		const target = ducked ? DUCKED : 1;
		if (target === this.target) return;
		this.target = target;
		this.flush();
	}

	/** Queues samples of a line, starting `from` seconds into it. */
	play(line: number, from: number, samples: Float32Array): void {
		if (samples.length === 0) return;
		this.queue.push({ line, from, samples, at: 0 });
		if (this.starved && !this.paused) this.flush();
		this.notify();
	}

	/** Whether speech sounds now. */
	get playing(): boolean {
		const run = this.at(this.sounded);
		if (run !== undefined) return run.stretch !== null;
		return this.queue.length > 0 && !this.paused;
	}

	/** Seconds of the line played so far. */
	progress(line: number): number {
		return this.progressOf.get(line) ?? 0;
	}

	pause(): void {
		if (this.paused) return;
		this.paused = true;
		this.flush();
	}

	resume(): void {
		if (!this.paused) return;
		this.paused = false;
		this.flush();
	}

	/** Drops everything still to play, or only what is left of one line. */
	stop(line?: number): void {
		const lines =
			line === undefined
				? [...this.queue, ...this.runs.flatMap((r) => r.stretch ?? [])].map(
						(s) => s.line,
					)
				: [line];
		for (const each of lines) this.stopped.add(each);
		this.queue = this.queue.filter((s) => !this.stopped.has(s.line));
		this.flush();
		this.notify();
	}

	/** How much of what was rendered the host still holds unplayed, in
	 * samples at `rate`. */
	holds(samples: number, rate: number): void {
		const ahead = this.resampler?.resampler ? this.ahead.length : 0;
		this.advance(this.rendered - this.toSpeech(samples + ahead, rate));
	}

	/** Renders the next `out.length` samples at `rate` into `out`. */
	render(out: Float32Array, rate: number): void {
		if (this.resampler?.rate !== rate) {
			this.resampler = {
				rate,
				resampler:
					rate === SPEECH_RATE ? null : new Resampler(SPEECH_RATE, rate),
			};
			this.ahead = new Float32Array(0);
		}
		const { resampler } = this.resampler;
		if (resampler === null) {
			this.speech(out);
			return;
		}
		while (this.ahead.length < out.length) {
			const missing = out.length - this.ahead.length;
			const speech = new Float32Array(
				Math.ceil((missing * SPEECH_RATE) / rate) + 1,
			);
			this.speech(speech);
			const made = resampler.push(speech);
			const ahead = new Float32Array(this.ahead.length + made.length);
			ahead.set(this.ahead);
			ahead.set(made, this.ahead.length);
			this.ahead = ahead;
		}
		out.set(this.ahead.subarray(0, out.length));
		this.ahead = this.ahead.slice(out.length);
	}

	/** Takes back the last `samples` rendered at `rate`, which the host
	 * dropped unplayed, to render them anew. */
	unrender(samples: number, rate: number): void {
		let back = this.toSpeech(samples, rate);
		if (this.resampler?.resampler) {
			// What was resampled ahead goes back too, and the resampling
			// starts over from where the host stopped.
			back += this.toSpeech(this.ahead.length, rate);
			this.resampler = null;
		}
		back = Math.min(back, this.rendered - this.sounded);
		this.rendered -= back;
		while (back > 0) {
			const run = this.runs.at(-1);
			if (run === undefined) break;
			const taken = Math.min(back, run.length);
			run.length -= taken;
			back -= taken;
			const stretch = run.stretch;
			if (stretch !== null && !this.stopped.has(stretch.line)) {
				stretch.at = run.at + run.length;
				if (this.queue[0] !== stretch) this.queue.unshift(stretch);
			}
			if (run.length === 0) this.runs.pop();
			else run.samples = run.samples.subarray(0, run.length);
		}
		this.starved = false;
		this.notify();
	}

	private toSpeech(samples: number, rate: number): number {
		return Math.round((samples * SPEECH_RATE) / rate);
	}

	/** Renders the next speech at `SPEECH_RATE` into `out`, silence where
	 * nothing plays. */
	private speech(out: Float32Array): void {
		const follow = 1 - Math.exp(-1 / (DUCKING * SPEECH_RATE));
		let i = 0;
		while (i < out.length && !this.paused) {
			const stretch = this.queue[0];
			if (stretch === undefined) break;
			const from = i;
			const at = stretch.at;
			for (; i < out.length && stretch.at < stretch.samples.length; i++) {
				this.gain += (this.target - this.gain) * follow;
				out[i] = (stretch.samples[stretch.at++] ?? 0) * this.gain;
			}
			this.keep(out.subarray(from, i), stretch, at);
			if (stretch.at === stretch.samples.length) this.queue.shift();
		}
		this.starved = i < out.length && !this.paused;
		if (i < out.length) {
			// The volume follows the duck through silence too.
			for (let j = i; j < out.length; j++) {
				this.gain += (this.target - this.gain) * follow;
				out[j] = 0;
			}
			this.keep(out.subarray(i), null, 0);
		}
		this.notify();
	}

	/** Keeps a run just rendered, joined to the last where it goes on from it. */
	private keep(samples: Float32Array, stretch: Stretch | null, at: number) {
		const last = this.runs.at(-1);
		const start = this.rendered;
		this.rendered += samples.length;
		if (
			last !== undefined &&
			last.stretch === stretch &&
			(stretch === null || last.at + last.length === at)
		) {
			const joined = new Float32Array(last.length + samples.length);
			joined.set(last.samples.subarray(0, last.length));
			joined.set(samples, last.length);
			last.samples = joined;
			last.length += samples.length;
			return;
		}
		this.runs.push({
			start,
			length: samples.length,
			stretch,
			at,
			samples: samples.slice(),
		});
	}

	/** The run that sample `at` of all lies in, if it was rendered. */
	private at(at: number): Run | undefined {
		return this.runs.find((r) => at >= r.start && at < r.start + r.length);
	}

	/** Moves what was played to sample `at` of all, into the lines' progress,
	 * and lets go of the runs played, but for what `level` hears. */
	private advance(at: number): void {
		if (at <= this.sounded) return;
		this.sounded = at;
		for (const run of this.runs) {
			if (run.start >= at || run.stretch === null) continue;
			const { line, from } = run.stretch;
			const reached =
				from + (run.at + Math.min(run.length, at - run.start)) / SPEECH_RATE;
			if (reached > (this.progressOf.get(line) ?? 0))
				this.progressOf.set(line, reached);
		}
		while (
			this.runs.length > 1 &&
			(this.runs[1] as Run).start + LEVEL <= at &&
			(this.runs[0] as Run).start + (this.runs[0] as Run).length <= at
		)
			this.runs.shift();
		this.notify();
	}

	private notify(): void {
		const live = (stretch: Stretch | null | undefined) =>
			stretch != null && !this.stopped.has(stretch.line);
		const run = this.at(this.sounded)?.stretch;
		const now = live(run) ? run : undefined;
		const later = this.runs.find(
			(r) => r.start >= this.sounded && live(r.stretch),
		)?.stretch;
		const head = (now ?? later ?? this.queue[0])?.line ?? null;
		if (head === this.head) return;
		this.head = head;
		this.changed(head);
	}
}
