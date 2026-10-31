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

/** The types the engine answers with. */
const ANSWERS = new Set(
	["transcript+json", "speech", "failed+json"].map((type) => PREFIX + type),
);

/** The engines in a session, as the page sees them: whether one is in, and
 * the answers to the page's requests as they come. */
export class Engines {
	/** The engines in the session that offered, by name. */
	private offered = new Set<string>();
	/** The latest offer's entry. */
	offer = 0;
	/** The voices the latest offer speaks with, the first where a request
	 * names none. */
	voices: string[] = [];
	private waiting = new Map<number, (answer: Answer) => void>();
	private early = new Map<number, Answer>();
	/** Who hears the partial answers to an entry, until its answer. */
	private partials = new Map<number, (entry: Entry) => void>();
	private ready: (() => void)[] = [];
	private readonly unsubscribe: () => void;
	private readonly session: Session;
	private readonly changed: (present: boolean, voices: string[]) => void;

	/** `changed` hears whether an engine is in, and the voices of the latest
	 * offer, as they change. */
	constructor(
		session: Session,
		changed: (present: boolean, voices: string[]) => void,
	) {
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
			try {
				const { voices } = JSON.parse(entry.text ?? "{}") as {
					voices?: unknown;
				};
				this.voices = Array.isArray(voices)
					? voices.filter((v): v is string => typeof v === "string")
					: [];
			} catch {
				this.voices = [];
			}
			for (const resolve of this.ready.splice(0)) resolve();
			this.changed(true, this.voices);
		} else if (
			type === "application/vnd.polylogue.leave" &&
			this.offered.delete(entry.from)
		)
			this.changed(this.present, this.voices);
		const of = params.find((param) => param.startsWith("of="));
		if (!type || !ANSWERS.has(type) || !of) return;
		const n = Number(of.slice(3));
		if (params.includes("partial")) {
			this.partials.get(n)?.(entry);
			return;
		}
		this.partials.delete(n);
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
		return this.answer(await this.send(body, type));
	}

	/** Sends an entry once an engine is in; its number. */
	async send(body: Blob | string, type: string): Promise<number> {
		await this.arrived();
		return this.session.send(body, { type });
	}

	/** The engine's answer to entry `n`, with `partial` hearing the partial
	 * answers that come before it. */
	async answer(n: number, partial?: (entry: Entry) => void): Promise<Entry> {
		const early = this.early.get(n);
		this.early.delete(n);
		if (partial && early === undefined) this.partials.set(n, partial);
		const answer =
			early ??
			(await new Promise<Answer>((resolve) => this.waiting.set(n, resolve)));
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

/** How often the audio of a stretch still going on is sent, in seconds: the
 * engine answers each with the words heard so far. */
const CHUNK = 0.25;

/** A stretch on its way to the engine: where its audio starts, after its
 * context, how far it is sent, where it ends once it did, and the entry that
 * opened it once that is sent; whether an entry is on its way, and whether
 * the last is sent. */
type Sending = {
	start: number;
	sent: number;
	end: number | null;
	n: number | null;
	busy: boolean;
	done: boolean;
	opened: (n: number) => void;
	failed: (error: Error) => void;
};

/** Hears through the engine, a stretch at a time: each is sent as it is
 * heard, with the speech before it as context, whose words are dropped by
 * their times, and the engine answers with the words so far as they come and
 * with all of them once the person paused after it. So a turn's end waits
 * only for the last hearing of its last stretch. What is heard between two
 * commits is one segment. */
export class LocalTranscriber implements Transcriber {
	sent = 0;
	/** What was heard, as chunks with where each starts in the stream, in
	 * seconds, back to what a stretch may still need. */
	private heard: { pcm: Int16Array; at: number }[] = [];
	/** Seconds of the stream, heard or skipped. */
	private stream = 0;
	/** Where the stretch in progress starts, null while the person is silent. */
	private from: number | null = null;
	/** The stretch in progress on its way, once it started. */
	private open: Sending | null = null;
	/** The stretches still being sent, the one in progress included. */
	private sending: Sending[] = [];
	/** Where the last stretch ended: the words before are its. */
	private ended = Number.NEGATIVE_INFINITY;
	/** Where the pauses heard but not yet reached by the audio are. */
	private cuts: number[] = [];
	/** The stretches of the segment in progress, in order: their words, the
	 * words once they came, and the words heard so far until then. */
	private stretches: {
		words: Promise<Transcribed>;
		came: Transcribed | null;
		partial: Transcribed | null;
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
		if (this.from !== null) this.pump(this.open ?? this.start(this.from));
		// What a stretch may still need: its context, and what is not yet sent.
		const kept = Math.min(
			this.stream - CONTEXT - 1,
			...this.sending.map((sending) => sending.sent),
		);
		while (
			this.heard[0] &&
			this.heard[0].at + this.heard[0].pcm.length / LISTEN_RATE < kept
		)
			this.heard.shift();
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

	/** Starts sending the stretch that starts at `from`, after its context. */
	private start(from: number): Sending {
		// The context reaches back only over what was heard without a gap.
		let start = from;
		for (let i = this.heard.length - 1; i >= 0; i--) {
			const chunk = this.heard[i] as { pcm: Int16Array; at: number };
			const end = chunk.at + chunk.pcm.length / LISTEN_RATE;
			if (chunk.at >= from) continue;
			if (end < start - 1e-6 || start <= from - CONTEXT) break;
			start = Math.max(chunk.at, from - CONTEXT);
		}
		// Speech detection hears a soft start late, so the stretch's words
		// start where the last stretch's end, not where speech was heard.
		const owned = this.ended;
		let opened: (n: number) => void = () => {};
		let failed: (error: Error) => void = () => {};
		const n = new Promise<number>((resolve, reject) => {
			opened = resolve;
			failed = reject;
		});
		const open: Sending = {
			start,
			sent: start,
			end: null,
			n: null,
			busy: false,
			done: false,
			opened,
			failed,
		};
		const transcribed = (entry: Entry): Transcribed => {
			const { words } = JSON.parse(entry.text ?? "{}") as { words: Word[] };
			const placed = words.map((w) => ({
				...w,
				start: w.start + start,
				end: w.end + start,
			}));
			return { words: placed, start, from, owned };
		};
		const stretch: (typeof this.stretches)[number] = {
			words: n.then((n) =>
				this.engines
					.answer(n, (entry) => {
						if (stretch.came !== null) return;
						stretch.partial = transcribed(entry);
						this.show();
					})
					.then(transcribed),
			),
			came: null,
			partial: null,
		};
		this.stretches.push(stretch);
		stretch.words.then(
			(words) => {
				stretch.came = words;
				this.show();
			},
			() => {},
		);
		this.open = open;
		this.sending.push(open);
		return open;
	}

	/** Sends what is heard of a stretch and not yet sent, one entry at a
	 * time, with its end once it ended. */
	private pump(sending: Sending): void {
		if (sending.busy || sending.done || this.closed) return;
		const to = sending.end ?? this.stream;
		if (sending.end === null && to - sending.sent < CHUNK) return;
		sending.busy = true;
		const type = [
			TRANSCRIBE,
			...(sending.n === null ? [] : [`of=${sending.n}`]),
			...(sending.end === null
				? []
				: [`end=${(sending.end - sending.start).toFixed(3)}`]),
		].join("; ");
		const pcm = this.audio(sending.sent, Math.max(sending.sent, to));
		const ending = sending.end !== null;
		this.engines.send(wav(pcm, LISTEN_RATE), type).then(
			(n) => {
				if (sending.n === null) {
					sending.n = n;
					sending.opened(n);
				}
				sending.sent = Math.max(sending.sent, to);
				sending.busy = false;
				if (ending) {
					sending.done = true;
					this.sending = this.sending.filter((other) => other !== sending);
					return;
				}
				this.pump(sending);
			},
			(error: Error) => {
				sending.busy = false;
				this.sending = this.sending.filter((other) => other !== sending);
				sending.failed(error);
			},
		);
	}

	/** The audio heard from `from` to `to`, in seconds of the stream, with
	 * silence where nothing was heard. */
	private audio(from: number, to: number): Int16Array {
		const first = Math.round(from * LISTEN_RATE);
		const last = Math.round(to * LISTEN_RATE);
		const pcm = new Int16Array(Math.max(0, last - first));
		for (const chunk of this.heard) {
			const offset = Math.round(chunk.at * LISTEN_RATE) - first;
			const head = Math.max(0, -offset);
			const tail = Math.min(chunk.pcm.length, pcm.length - offset);
			if (tail > head) pcm.set(chunk.pcm.subarray(head, tail), offset + head);
		}
		return pcm;
	}

	/** Ends the stretch in progress at `at`, and has the rest of it sent. */
	private cut(at: number): void {
		const from = this.from;
		if (from === null || at <= from) return;
		const open = this.open ?? this.start(from);
		this.from = null;
		this.open = null;
		this.ended = at;
		open.end = at;
		this.pump(open);
	}

	/** What came so far of the segment in progress, as its partial. */
	private show(): void {
		const committed = this.committed;
		committed.then((prior) => {
			if (this.closed || committed !== this.committed) return;
			const came: Transcribed[] = [];
			for (const { came: words, partial } of this.stretches) {
				const heard = words ?? partial;
				if (heard === null) break;
				came.push(heard);
			}
			if (came.length === 0) return;
			this.heardBy.partial(
				spaced(joined(prior, came))
					.map((word) => word.text)
					.join(""),
			);
		});
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

/** The silence put before a sentence that follows another, in seconds: the
 * engine's speech has about 0.17 s of its own between two sentences, too
 * little to hear a sentence's end. A clause of a split sentence gets none. */
const PAUSE = 0.25;

/** The engine's speech of a text is about this long, in seconds, and takes
 * about `making` to come back, round trip included: Kokoro on the server. */
const spoken = (text: string) => 0.15 + [...text].length / 17;
const making = (text: string) => 0.45 + spoken(text) / 3;

/** The sentences of a line as they are asked of the engine, one at a time:
 * a sentence that would take longer to make than the one before it plays is
 * split at a comma, so that its first part is there in time; the rest goes
 * on likewise. Only there, since a split changes the sentence's melody. */
function units(texts: string[]): { text: string; clause: boolean }[] {
	const all: { text: string; clause: boolean }[] = [];
	for (const sentence of texts) {
		let rest = sentence;
		let clause = false;
		for (;;) {
			const before = all.at(-1);
			const commas = [...rest.matchAll(/,\s+/g)].map((m) => ({
				at: (m.index ?? 0) + 1,
				next: (m.index ?? 0) + m[0].length,
			}));
			if (
				before === undefined ||
				commas.length === 0 ||
				making(rest) <= spoken(before.text)
			)
				break;
			// The longest first part made in time, else the shortest.
			const fits = commas.filter(
				(c) => making(rest.slice(0, c.at)) <= spoken(before.text),
			);
			const cut = fits.at(-1) ?? (commas[0] as { at: number; next: number });
			all.push({ text: rest.slice(0, cut.at), clause });
			rest = rest.slice(cut.next);
			clause = true;
		}
		all.push({ text: rest, clause });
	}
	return all;
}

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Kokoro's voices that sound most apart, from the one before and from
 * af_heart, its default: for the agents after the first. */
const APART = [
	"am_michael",
	"bf_emma",
	"am_fenrir",
	"bm_george",
	"af_bella",
	"am_puck",
	"af_nicole",
	"bm_fable",
];

/** The engine's `offered` voices in the order the agents get them: the
 * `chosen` one first, then those that sound most apart, then the rest, each
 * once and over again. */
export function voiceOrder(chosen: string | null, offered: string[]): string[] {
	const first = chosen !== null && offered.includes(chosen) ? [chosen] : [];
	return [
		...new Set([
			...first,
			...APART.filter((voice) => offered.includes(voice)),
			...offered,
		]),
	];
}

/** Speaks through the engine a sentence at a time, so that the first plays
 * while the rest is made. A sentence is asked once the audio still to play
 * would run out before it is made, the sentences asked before it included:
 * so the speech goes on without a hole, and little waits at the engine
 * behind a line no longer wanted. */
export class LocalSynthesizer implements Synthesizer {
	/** The audio of lines, handed over in order. */
	private queue: Promise<void> = Promise.resolve();
	/** The requests to the engine, sent one after the other. */
	private asking: Promise<unknown> = Promise.resolve();
	/** When the audio handed over is played to, by `performance.now()`, as if
	 * each piece played as it came. */
	private played = 0;
	/** Of the sentences asked and not yet back: their expected audio and the
	 * time they take to make, in seconds. */
	private coming = 0;
	private unmade = 0;
	/** Lines not yet handed over in full. */
	private pending = 0;
	private closed = false;
	private readonly engines: Engines;
	/** The engine's voices in their order, as chosen when a sentence is
	 * asked. */
	private readonly voices: () => string[];

	constructor(engines: Engines, voices: () => string[]) {
		this.engines = engines;
		this.voices = voices;
	}

	/** The engine's `n`th voice, over again past the last: none before it
	 * offered any, for its default. */
	private voice(n: number): string | undefined {
		const voices = this.voices();
		return voices[n % voices.length];
	}

	say(
		line: string,
		piece: (piece: Piece) => boolean,
		voice = 0,
	): Promise<void> {
		const texts = [...sentences.segment(line)]
			.map(({ segment }) => segment.trim())
			.filter((text) => /[\p{L}\p{N}]/u.test(text));
		// A line said while another is still being made follows it.
		const follows = this.pending > 0;
		this.pending++;
		let wanted = true;
		const parts = units(texts);
		const asked = parts.map(({ text }) => {
			const sent = this.asking.then(async () => {
				while (wanted && !this.closed && !this.due(text)) await sleep(50);
				if (!wanted || this.closed) return null;
				this.coming += spoken(text);
				this.unmade += making(text);
				return this.engines.send(
					JSON.stringify({ text, voice: this.voice(voice) }),
					SYNTHESIZE,
				);
			});
			this.asking = sent.catch(() => {});
			return sent.then(async (n) => {
				if (n === null) return null;
				try {
					return await this.engines.payload(await this.engines.answer(n));
				} finally {
					this.coming -= spoken(text);
					this.unmade -= making(text);
				}
			});
		});
		const said = this.queue
			.then(async () => {
				for (const [i, audio] of asked.entries()) {
					const data = await audio;
					if (data === null || this.closed) return;
					const speech = samples(data, SPEECH_RATE);
					const clause = parts[i]?.clause ?? false;
					const pause = !clause && (i > 0 || follows) ? PAUSE : 0;
					const all = new Float32Array(
						Math.round(pause * SPEECH_RATE) + speech.length,
					);
					all.set(speech, all.length - speech.length);
					// The engine times no characters, so they are spread evenly
					// over the sentence, which joins the one before with a space.
					const text = (i > 0 ? " " : "") + (parts[i]?.text ?? "");
					const seconds = speech.length / SPEECH_RATE;
					const chars = [...text].map((char, j) => ({
						char,
						at: pause + (j / text.length) * seconds,
					}));
					const now = performance.now();
					this.played =
						Math.max(now, this.played) + (all.length / SPEECH_RATE) * 1000;
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

	/** Whether `text` is to be asked now: the audio still to play, that
	 * coming included, would run out before it and the sentences ahead of it
	 * are made. */
	private due(text: string): boolean {
		const left = Math.max(0, this.played - performance.now()) / 1000;
		return this.unmade + making(text) >= left + this.coming;
	}

	close(): void {
		this.closed = true;
	}
}
