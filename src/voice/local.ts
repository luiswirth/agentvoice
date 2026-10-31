// The local tier: an engine in the session, a participant that transcribes
// and speaks on a machine the person's agent can act on, as public/engine.md
// specifies. The page sends it a stretch or a sentence, and gets the answer
// as an entry of its own.

import {
	type Heard,
	LISTEN_RATE,
	Offsets,
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

/** Hears through the engine: what is heard between two commits is one
 * stretch, transcribed as a whole. */
export class LocalTranscriber implements Transcriber {
	private readonly offsets = new Offsets();
	private stretch: Int16Array[] = [];
	private closed = false;
	/** Transcripts still to come, in the order of their stretches. */
	private queue: Promise<void> = Promise.resolve();
	private readonly engines: Engines;
	private readonly heard: Heard;

	constructor(engines: Engines, heard: Heard) {
		this.engines = engines;
		this.heard = heard;
	}

	get sent(): number {
		return this.offsets.sent;
	}

	hear(pcm: Int16Array): void {
		this.offsets.hear(pcm.length);
		this.stretch.push(pcm.slice());
	}

	skip(samples: number): void {
		this.offsets.skip(samples);
	}

	commit(): boolean {
		const length = this.stretch.reduce((sum, pcm) => sum + pcm.length, 0);
		if (length < 0.3 * LISTEN_RATE) return false;
		const pcm = new Int16Array(length);
		let at = 0;
		for (const part of this.stretch.splice(0)) {
			pcm.set(part, at);
			at += part.length;
		}
		const base = this.offsets.sent - length;
		const asked = this.engines
			.ask(wav(pcm, LISTEN_RATE), TRANSCRIBE)
			.then(
				(entry) =>
					JSON.parse(entry.text ?? "{}") as { text: string; words: Word[] },
			);
		this.queue = this.queue.then(async () => {
			try {
				const { text, words } = await asked;
				if (this.closed) return;
				this.heard.committed(
					text,
					false,
					words.map((word) => this.offsets.place(word, base)),
				);
			} catch (error) {
				if (!this.closed) this.heard.closed(error as Error);
				this.closed = true;
			}
		});
		return true;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.heard.closed();
	}
}

/** Speaks through the engine, a line as a whole. */
export class LocalSynthesizer implements Synthesizer {
	private queue: Promise<void> = Promise.resolve();
	private closed = false;
	private readonly engines: Engines;

	constructor(engines: Engines) {
		this.engines = engines;
	}

	say(line: string, piece: (piece: Piece) => boolean): Promise<void> {
		// Asked at once, so that the engine works on it while the lines before play.
		const asked = this.engines
			.ask(JSON.stringify({ text: line }), SYNTHESIZE)
			.then((entry) => this.engines.payload(entry));
		const said = this.queue.then(async () => {
			const audio = samples(await asked, SPEECH_RATE);
			if (this.closed) return;
			// The engine times no characters, so they are spread evenly over the line.
			const seconds = audio.length / SPEECH_RATE;
			const chars = [...line].map((char, i) => ({
				char,
				at: (i / line.length) * seconds,
			}));
			piece({ samples: audio, chars });
		});
		this.queue = said.catch(() => {});
		return said;
	}

	close(): void {
		this.closed = true;
	}
}
