// Hearing and speaking on local models in the browser, each in a worker of
// its own: Moonshine Small Streaming English hears, Phonon 31m English
// speaks. Each is fetched once and kept in the browser's cache, and loaded
// once for the page, so that turning listening or reading aloud off and on
// again costs no time.

import { PhononTTS } from "phonon-tts";
import {
	type Heard,
	LISTEN_RATE,
	Offsets,
	type Piece,
	SPEECH_RATE,
	type Synthesizer,
	type Transcriber,
} from "./engines.ts";
import type { FromMoonshine, ToMoonshine } from "./moonshine-worker.ts";
import MoonshineWorker from "./moonshine-worker.ts?worker";

/** The page's Moonshine, once asked for, and the one transcriber it is for. */
let moonshine: { worker: Worker; ready: Promise<void> } | null = null;
let current: Moonshine | null = null;
/** Resets asked for and not yet done: what comes before one is for a
 * transcriber closed since. */
let resets = 0;

function loadMoonshine(): { worker: Worker; ready: Promise<void> } {
	if (moonshine) return moonshine;
	const worker = new MoonshineWorker();
	const ready = new Promise<void>((resolve, reject) => {
		const fail = (error: Error) => {
			reject(error);
			current?.heard.closed(error);
			current = null;
			moonshine = null;
			worker.terminate();
		};
		worker.onmessage = ({ data }: MessageEvent<FromMoonshine>) => {
			if (data.type === "ready") return resolve();
			if (data.type === "failed")
				return fail(new Error(`Moonshine failed: ${data.error}`));
			if (data.type === "reset") {
				resets--;
				return;
			}
			if (resets === 0) current?.told(data);
		};
		worker.onerror = (event) =>
			fail(new Error(`Moonshine failed: ${event.message}`));
	});
	moonshine = { worker, ready };
	return moonshine;
}

/** Moonshine hears English only, whatever the person speaks. Its segments
 * end only where `commit` settles them. */
export class Moonshine implements Transcriber {
	private readonly worker: Worker;
	readonly heard: Heard;
	private readonly offsets = new Offsets();
	/** Samples sent since the last commit. */
	private uncommitted = 0;
	/** Where in what was sent each segment being settled ends, in order. */
	private readonly ends: number[] = [];
	/** Where in what was sent the segment settled next starts. */
	private start = 0;

	private constructor(worker: Worker, heard: Heard) {
		this.worker = worker;
		this.heard = heard;
	}

	/** Opens once the model is loaded, which the first one loads. */
	static async open(heard: Heard): Promise<Moonshine> {
		const { worker, ready } = loadMoonshine();
		await ready;
		current?.close();
		current = new Moonshine(worker, heard);
		return current;
	}

	/** What the worker tells of this transcriber's stream. */
	told(data: FromMoonshine): void {
		if (data.type === "partial") this.heard.partial(data.text);
		if (data.type !== "committed") return;
		const start = this.start;
		this.start = this.ends.shift() ?? this.offsets.sent;
		this.heard.committed(
			data.text,
			false,
			data.words.map((word) => this.offsets.place(word, start)),
		);
	}

	get sent(): number {
		return this.offsets.sent;
	}

	hear(pcm: Int16Array): void {
		if (current !== this) return;
		this.offsets.hear(pcm.length);
		this.uncommitted += pcm.length;
		const copy = pcm.slice();
		this.post({ type: "audio", pcm: copy.buffer }, [copy.buffer]);
	}

	skip(samples: number): void {
		this.offsets.skip(samples);
	}

	/** A segment of under 0.4 s is left to the next, as Scribe's is. */
	commit(): boolean {
		if (current !== this) return false;
		if (this.uncommitted < (2 * LISTEN_RATE) / 5) return false;
		this.uncommitted = 0;
		this.ends.push(this.offsets.sent);
		this.post({ type: "commit" });
		return true;
	}

	/** Leaves the model loaded, for the next. */
	close(): void {
		if (current !== this) return;
		current = null;
		resets++;
		this.post({ type: "reset" });
	}

	private post(message: ToMoonshine, transfer: Transferable[] = []): void {
		this.worker.postMessage(message, transfer);
	}
}

/** The page's Phonon, once asked for. */
let phonon: Promise<PhononTTS> | null = null;

function loadPhonon(): Promise<PhononTTS> {
	if (phonon) return phonon;
	const loaded = PhononTTS.load({ lang: "en", device: "cpu" });
	phonon = loaded;
	// One that failed to load is loaded again next time.
	loaded.catch(() => {
		if (phonon === loaded) phonon = null;
	});
	return loaded;
}

const sentences = new Intl.Segmenter("en", { granularity: "sentence" });

/**
 * Phonon gives no times for what it says, so each sentence is spoken on its
 * own, and its characters are spread evenly over its audio once that is
 * done. It runs on the CPU: with Phonon on WebGPU, opening the page again
 * right after crashes the iPhone's tab.
 */
export class Phonon implements Synthesizer {
	private readonly loaded = loadPhonon();
	private queue: Promise<void> = Promise.resolve();
	private closed = false;

	/** Resolves once the model is loaded, or rejects if it fails to load. */
	ready(): Promise<void> {
		return this.loaded.then(() => {});
	}

	say(line: string, piece: (piece: Piece) => boolean): Promise<void> {
		const spoken = this.queue.then(() => this.speak(line, piece));
		this.queue = spoken.catch(() => {});
		return spoken;
	}

	private async speak(
		line: string,
		piece: (piece: Piece) => boolean,
	): Promise<void> {
		const tts = await this.loaded;
		if (this.closed) return;
		if (tts.sampleRate !== SPEECH_RATE)
			throw new Error(`Phonon speaks at ${tts.sampleRate} Hz`);
		/** Seconds of the line's audio so far. */
		let start = 0;
		for (const { segment } of sentences.segment(line)) {
			let samples = 0;
			// A sentence with nothing to say, such as a dash, says nothing.
			if (/[\p{L}\p{N}]/u.test(segment))
				for await (const chunk of tts.stream(segment.trim())) {
					samples += chunk.length;
					if (this.closed || !piece({ samples: chunk, chars: [] })) return;
				}
			const length = samples / SPEECH_RATE;
			const chars = [...segment].map((char, i, all) => ({
				char,
				at: start + (length * i) / all.length,
			}));
			if (!piece({ samples: new Float32Array(0), chars })) return;
			start += length;
		}
	}

	/** Stops speaking, and leaves the model loaded, for the next. */
	close(): void {
		this.closed = true;
	}
}
