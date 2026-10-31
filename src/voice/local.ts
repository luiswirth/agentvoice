// The local tier: an engine in the session, a participant that transcribes
// and speaks on a machine the person's agent can act on, as public/engine.md
// specifies. The page sends it a stretch or a sentence, and gets the answer
// as an entry of its own.

import {
	type Heard,
	LISTEN_RATE,
	type Piece,
	SPEECH_RATE,
	type Synthesizer,
	type Transcriber,
	type Word,
} from "./engines.ts";
import type { Entry, Session } from "./protocol.ts";

const PREFIX = "application/vnd.polylogue.engine.";
export const TRANSCRIBE = `${PREFIX}transcribe`;
export const SYNTHESIZE = `${PREFIX}synthesize+json`;

/** The engine's answer to entry `n`: its payload's entry, or why it failed. */
type Answer = Entry | Error;

/** The engines in a session, as the page sees them: whether one is in, and
 * the answers to the page's requests as they come. */
export class Engines {
	/** The engines in the session that offered, by name. */
	private offered = new Set<string>();
	/** The latest offer's entry. */
	offer = 0;
	private waiting = new Map<number, (answer: Answer) => void>();
	private early = new Map<number, Answer>();
	private ready: (() => void)[] = [];
	private readonly unsubscribe: () => void;
	private readonly session: Session;
	private readonly changed: (present: boolean) => void;

	/** `changed` hears whether an engine is in, as it changes. */
	constructor(session: Session, changed: (present: boolean) => void) {
		this.session = session;
		this.changed = changed;
		this.unsubscribe = session.subscribe({
			entry: (entry) => this.entry(entry),
		});
	}

	private entry(entry: Entry): void {
		const [type, ...params] = entry.type.split(";").map((part) => part.trim());
		if (type === `${PREFIX}offer+json`) {
			this.offered.add(entry.from);
			this.offer = entry.n;
			for (const resolve of this.ready.splice(0)) resolve();
			this.changed(true);
		} else if (
			type === "application/vnd.polylogue.leave" &&
			this.offered.delete(entry.from)
		)
			this.changed(this.present);
		const of = params.find((param) => param.startsWith("of="));
		if (!type?.startsWith(PREFIX) || !of) return;
		const n = Number(of.slice(3));
		const answer =
			type === `${PREFIX}failed+json`
				? new Error(
						`The engine failed: ${JSON.parse(entry.text ?? "{}").error}`,
					)
				: entry;
		const resolve = this.waiting.get(n);
		this.waiting.delete(n);
		if (resolve) resolve(answer);
		else this.early.set(n, answer);
	}

	/** Whether an engine is in the session. */
	get present(): boolean {
		return this.offered.size > 0;
	}

	/** Resolves once an engine is in the session. */
	arrived(): Promise<void> {
		if (this.present) return Promise.resolve();
		return new Promise((resolve) => this.ready.push(resolve));
	}

	/** Sends a request once an engine is in, and waits for its answer. */
	async ask(body: Blob | string, type: string): Promise<Entry> {
		await this.arrived();
		const n = await this.session.send(body, { type });
		const answer =
			this.early.get(n) ??
			(await new Promise<Answer>((resolve) => this.waiting.set(n, resolve)));
		this.early.delete(n);
		if (answer instanceof Error) throw answer;
		return answer;
	}

	async payload(entry: Entry): Promise<ArrayBuffer> {
		return (await this.session.fetch(entry.n)).arrayBuffer();
	}

	close(): void {
		this.unsubscribe();
	}
}

/** A WAV of 16-bit mono PCM. */
function wav(pcm: Int16Array, rate: number): Blob {
	const header = new DataView(new ArrayBuffer(44));
	const text = (at: number, s: string) => {
		for (let i = 0; i < s.length; i++) header.setUint8(at + i, s.charCodeAt(i));
	};
	text(0, "RIFF");
	header.setUint32(4, 36 + pcm.byteLength, true);
	text(8, "WAVEfmt ");
	header.setUint32(16, 16, true);
	header.setUint16(20, 1, true);
	header.setUint16(22, 1, true);
	header.setUint32(24, rate, true);
	header.setUint32(28, rate * 2, true);
	header.setUint16(32, 2, true);
	header.setUint16(34, 16, true);
	text(36, "data");
	header.setUint32(40, pcm.byteLength, true);
	return new Blob([header, pcm.slice().buffer], { type: TRANSCRIBE });
}

/** The samples of a WAV of 16-bit mono PCM at `rate`, as floats. */
function samples(data: ArrayBuffer, rate: number): Float32Array {
	const view = new DataView(data);
	if (view.getUint32(24, true) !== rate)
		throw new Error(`The engine's speech isn't at ${rate} Hz.`);
	// The data chunk is the last; anything before it is skipped.
	let at = 12;
	while (at + 8 <= data.byteLength) {
		const id = String.fromCharCode(...new Uint8Array(data, at, 4));
		const size = view.getUint32(at + 4, true);
		if (id === "data") {
			const pcm = new Int16Array(data.slice(at + 8, at + 8 + size));
			return Float32Array.from(pcm, (s) => s / 32768);
		}
		at += 8 + size;
	}
	throw new Error("The engine's speech has no audio.");
}

/** How much of the speech before a stretch the engine hears with it, in
 * seconds, so that the stretch is transcribed in its context: a sentence it
 * goes on keeps going, rather than ending at each pause. */
const CONTEXT = 2;

/** Hears through the engine, a stretch at a time: each is transcribed as the
 * person pauses after it, with the speech before it as context, whose words
 * are dropped by their times, so that a turn's end waits only for its last
 * stretch. What is heard between two commits is one segment. */
export class LocalTranscriber implements Transcriber {
	sent = 0;
	/** What was heard, as chunks with where each starts in the stream, in
	 * seconds, back to the context of the stretch in progress. */
	private heard: { pcm: Int16Array; at: number }[] = [];
	/** Seconds of the stream, heard or skipped. */
	private stream = 0;
	/** Where the stretch in progress starts, null while the person is silent. */
	private from: number | null = null;
	/** Where the last stretch ended: the words before are its. */
	private ended = Number.NEGATIVE_INFINITY;
	/** Where the pauses heard but not yet reached by the audio are. */
	private cuts: number[] = [];
	/** The stretches of the segment in progress, in order: their words, and
	 * the words once they came. */
	private stretches: {
		words: Promise<Transcribed>;
		came: Transcribed | null;
	}[] = [];
	/** The words of the segment committed last, spacing left out: the first
	 * stretch after it may have heard them again in its context, and a commit
	 * is final, so they are joined to it as they are. */
	private committed: Promise<Word[]> = Promise.resolve([]);
	private closed = false;
	/** Commits still to answer, in order. */
	private queue: Promise<void> = Promise.resolve();
	private readonly engines: Engines;
	private readonly heardBy: Heard;

	constructor(engines: Engines, heard: Heard) {
		this.engines = engines;
		this.heardBy = heard;
	}

	hear(pcm: Int16Array): void {
		this.heard.push({ pcm: pcm.slice(), at: this.stream });
		this.stream += pcm.length / LISTEN_RATE;
		this.sent += pcm.length;
		while ((this.cuts[0] ?? Number.POSITIVE_INFINITY) <= this.stream)
			this.cut(this.cuts.shift() as number);
	}

	skip(samples: number): void {
		this.stream += samples / LISTEN_RATE;
	}

	spoke(at: number): void {
		this.from = at;
	}

	paused(at: number): void {
		if (at <= this.stream) this.cut(at);
		else this.cuts.push(at);
	}

	commit(): boolean {
		for (const at of this.cuts.splice(0)) this.cut(Math.min(at, this.stream));
		// Speech still going on is cut where it was heard to, and goes on.
		if (this.from !== null) {
			this.cut(this.stream);
			this.from = this.stream;
		}
		if (this.stretches.length === 0) return false;
		const stretches = this.stretches.splice(0);
		const committed = this.committed.then(async (prior) =>
			joined(prior, await Promise.all(stretches.map((s) => s.words))),
		);
		this.committed = committed.catch(() => []);
		this.queue = this.queue.then(async () => {
			try {
				const words = spaced(await committed);
				if (this.closed) return;
				this.heardBy.committed(
					words.map((word) => word.text).join(""),
					false,
					words,
				);
			} catch (error) {
				if (!this.closed) this.heardBy.closed(error as Error);
				this.closed = true;
			}
		});
		return true;
	}

	/** Ends the stretch in progress at `at`, and has it transcribed. */
	private cut(at: number): void {
		const from = this.from;
		if (from === null || at <= from) return;
		this.from = null;
		// Speech detection hears a soft start late, so the stretch's words
		// start where the last stretch's end, not where speech was heard.
		const owned = this.ended;
		this.ended = at;
		// The context reaches back only over what was heard without a gap.
		let start = from;
		for (let i = this.heard.length - 1; i >= 0; i--) {
			const chunk = this.heard[i] as { pcm: Int16Array; at: number };
			const end = chunk.at + chunk.pcm.length / LISTEN_RATE;
			if (chunk.at >= from) continue;
			if (end < start - 1e-6 || start <= from - CONTEXT) break;
			start = Math.max(chunk.at, from - CONTEXT);
		}
		const first = Math.round(start * LISTEN_RATE);
		const last = Math.round(at * LISTEN_RATE);
		const pcm = new Int16Array(Math.max(0, last - first));
		for (const chunk of this.heard) {
			const offset = Math.round(chunk.at * LISTEN_RATE) - first;
			const head = Math.max(0, -offset);
			const tail = Math.min(chunk.pcm.length, pcm.length - offset);
			if (tail > head) pcm.set(chunk.pcm.subarray(head, tail), offset + head);
		}
		// What the next stretch's context may still need.
		while (
			(this.heard[0]?.at ?? at) +
				(this.heard[0]?.pcm.length ?? 0) / LISTEN_RATE <
			at - CONTEXT
		)
			this.heard.shift();
		const stretch: (typeof this.stretches)[number] = {
			words: this.engines
				.ask(wav(pcm, LISTEN_RATE), TRANSCRIBE)
				.then((entry) => {
					const { words } = JSON.parse(entry.text ?? "{}") as { words: Word[] };
					const placed = words.map((w) => ({
						...w,
						start: w.start + start,
						end: w.end + start,
					}));
					return { words: placed, start, from, owned };
				}),
			came: null,
		};
		this.stretches.push(stretch);
		// What came so far of the segment in progress, as its partial.
		stretch.words.then(
			(words) => {
				stretch.came = words;
				this.committed.then((prior) => {
					const segment = this.stretches;
					if (this.closed || !segment.includes(stretch)) return;
					const came: Transcribed[] = [];
					for (const { came: words } of segment) {
						if (words === null) break;
						came.push(words);
					}
					this.heardBy.partial(
						spaced(joined(prior, came))
							.map((word) => word.text)
							.join(""),
					);
				});
			},
			() => {},
		);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.heardBy.closed();
	}
}

/** What the engine heard of a stretch: the words of all it was sent, in
 * seconds of the stream, where that starts, where the stretch itself starts
 * after its context, and where the stretch before ended. */
type Transcribed = {
	words: Word[];
	start: number;
	from: number;
	owned: number;
};

/**
 * The words of a segment's stretches, in order, after `prior`, the words
 * committed before them, which stay as they are; spacing left out. A stretch
 * was heard with the end of the one before as context, so the two hearings
 * overlap from where the context starts to where the stretch before ended.
 * Each word is best heard where it is farthest from the edge of what was
 * sent, so the overlap is split at its middle: before it, the words come from
 * the stretch before; after it, from this one, which knows how the speech
 * goes on, and drops the false end of a sentence at a pause. The split falls
 * on a word both heard alike, so that none is lost or doubled. Where there is
 * none, a word belongs to the stretch its middle lies in.
 */
function joined(prior: Word[], stretches: Transcribed[]): Word[] {
	let words = prior;
	for (const { words: heard, start, from, owned } of stretches) {
		const split = splitting(words, prior.length, heard, start, from, owned);
		words = split
			? [...words.slice(0, split.before), ...heard.slice(split.from)]
			: [
					...words,
					...heard.filter(
						(w) =>
							(w.start + w.end) / 2 >=
							Math.max(owned, prior.at(-1)?.end ?? Number.NEGATIVE_INFINITY),
					),
				];
	}
	return words.slice(prior.length);
}

/** Where to split the overlap of `before` and `heard`: `before` keeps its
 * words up to `before`, and `heard` gives its words from `from` on. Only
 * words both heard alike are split at, as a longest common subsequence of
 * the words in the overlap aligns them, and the first `fixed` of `before`
 * stay. */
function splitting(
	before: Word[],
	fixed: number,
	heard: Word[],
	start: number,
	from: number,
	owned: number,
): { before: number; from: number } | null {
	const key = (w: Word) => w.text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
	// The words of each hearing the overlap may hold.
	let first = before.length;
	while (first > 0 && (before[first - 1] as Word).end > start) first--;
	let last = 0;
	while (last < heard.length && (heard[last] as Word).start < from) last++;
	const a = before.slice(first).map(key);
	const b = heard.slice(0, last).map(key);
	// common(i, j): how many words a[i..] and b[j..] have in common, in order.
	const width = b.length + 1;
	const lcs = new Uint16Array((a.length + 1) * width);
	const common = (i: number, j: number) => lcs[i * width + j] ?? 0;
	for (let i = a.length - 1; i >= 0; i--)
		for (let j = b.length - 1; j >= 0; j--)
			lcs[i * width + j] =
				a[i] === b[j] && a[i] !== ""
					? common(i + 1, j + 1) + 1
					: Math.max(common(i + 1, j), common(i, j + 1));
	const middle = (start + owned) / 2;
	let best: { before: number; from: number; off: number } | null = null;
	const consider = (i: number, j: number, at: number) => {
		const off = Math.abs(at - middle);
		if (i >= fixed && (best === null || off < best.off))
			best = { before: i, from: j, off };
	};
	for (let i = 0, j = 0; i < a.length && j < b.length; )
		if (a[i] === b[j] && a[i] !== "") {
			const was = before[first + i] as Word;
			const is = heard[j] as Word;
			// Split before the pair, or after it.
			consider(first + i, j, (was.start + is.start) / 2);
			consider(first + i + 1, j + 1, (was.end + is.end) / 2);
			i++;
			j++;
		} else if (common(i + 1, j) >= common(i, j + 1)) i++;
		else j++;
	return best;
}

/** Words with the spacing between them. */
function spaced(words: Word[]): Word[] {
	return words.flatMap((word, i) => {
		const last = words[i - 1];
		return last
			? [{ text: " ", start: last.end, end: word.start }, word]
			: [word];
	});
}

const sentences = new Intl.Segmenter("en", { granularity: "sentence" });

/** The silence before a sentence that follows another, in seconds: the
 * engine's speech has hardly any at its ends, and without it a sentence's
 * end isn't heard. */
const PAUSE = 0.4;

/** Speaks through the engine a sentence at a time, so that the first plays
 * while the rest is made. The engine gets one sentence at a time, the next as
 * soon as the last is back: so it never idles while there is more to say, and
 * nothing waits at it behind a line no longer wanted. */
export class LocalSynthesizer implements Synthesizer {
	/** The audio of lines, handed over in order. */
	private queue: Promise<void> = Promise.resolve();
	/** The requests to the engine, one after the other. */
	private asking: Promise<unknown> = Promise.resolve();
	/** Lines not yet handed over in full. */
	private pending = 0;
	private closed = false;
	private readonly engines: Engines;

	constructor(engines: Engines) {
		this.engines = engines;
	}

	say(line: string, piece: (piece: Piece) => boolean): Promise<void> {
		const texts = [...sentences.segment(line)]
			.map(({ segment }) => segment.trim())
			.filter((text) => /[\p{L}\p{N}]/u.test(text));
		// A line said while another is still being made follows it.
		const follows = this.pending > 0;
		this.pending++;
		let wanted = true;
		const asked = texts.map((text) => {
			const audio = this.asking.then(() =>
				wanted && !this.closed
					? this.engines
							.ask(JSON.stringify({ text }), SYNTHESIZE)
							.then((entry) => this.engines.payload(entry))
					: null,
			);
			this.asking = audio.catch(() => {});
			return audio;
		});
		const said = this.queue
			.then(async () => {
				for (const [i, audio] of asked.entries()) {
					const data = await audio;
					if (data === null || this.closed) return;
					const speech = samples(data, SPEECH_RATE);
					const pause = i > 0 || follows ? PAUSE : 0;
					const all = new Float32Array(
						Math.round(pause * SPEECH_RATE) + speech.length,
					);
					all.set(speech, all.length - speech.length);
					// The engine times no characters, so they are spread evenly
					// over the sentence, which joins the one before with a space.
					const text = (i > 0 ? " " : "") + (texts[i] ?? "");
					const seconds = speech.length / SPEECH_RATE;
					const chars = [...text].map((char, j) => ({
						char,
						at: pause + (j / text.length) * seconds,
					}));
					if (!piece({ samples: all, chars })) {
						wanted = false;
						return;
					}
				}
			})
			.finally(() => this.pending--);
		this.queue = said.catch(() => {});
		return said;
	}

	close(): void {
		this.closed = true;
	}
}
