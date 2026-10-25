// The listener: what the person says, as text, from the microphone through
// Scribe. Turn detection runs in the page, on local models, and ends a
// segment once the person sounds done; whether a segment ends the person's
// turn is for whoever uses the listener to decide. A segment counts only
// once it is loud enough, so that the speaker's echo, which the browser's
// echo cancellation never removes entirely, is not taken for the person.
// Scribe hears each chunk once turn detection has, so that a commit at what
// turn detection marks lands where it marked it. Each stretch of speech is
// tagged by its voice, on a local speaker model, and a segment's words by
// the voice of their stretch, which it waits for if the model is not done.
import { Microphone } from "./audio.ts";
import { LISTEN_RATE, Scribe, type Word } from "./elevenlabs.ts";
import type { FromSpeakers, ToSpeakers } from "./speakers-worker.ts";
import SpeakersWorker from "./speakers-worker.ts?worker";
import type { FromTurns, ToTurns } from "./turns-worker.ts";
import TurnsWorker from "./turns-worker.ts?worker";
import { annotate, SHORTEST, type Stretch, Voices } from "./voices.ts";

export type Hearing = {
	/** Turn detection hears speech start, louder than the echo, or stop: a
	 * sound that may still turn out to be no words. */
	voiced(voiced: boolean): void;
	/** The person started saying words. */
	speaking(): void;
	/** What was heard so far of the segment in progress. */
	partial(text: string): void;
	/** A segment ended, empty if it held no words or never counted. */
	segment(text: string): void;
	/** What the microphone hears, as Scribe gets it, before it goes on. */
	audio(pcm: Int16Array): void;
	/** How loud the microphone is, from 0 to 1, every 0.1 s. */
	level(level: number): void;
	/** The listener stopped on its own. */
	failed(error: Error): void;
	/** What turn detection decided, for the trace. */
	trace(event: string, data: Record<string, unknown>): void;
};

/** The sound between turns after which it is committed and dropped, since
 * Scribe commits on its own after about 36 s, wherever the person is. */
const BETWEEN = 20 * LISTEN_RATE;

/** The longest stretch the speaker model hears at once, in seconds, so that
 * a long one is heard while it goes on, and a voice change inside it shows. */
const STRETCH = 10;

/** What a commit is for: a piece of the turn in progress, its end, or the
 * sound between turns, which is dropped. A pause commits a piece shortly
 * before it ends the turn, so that the turn's words are settled by then. */
type Commit = "piece" | "end" | "between";

export class Listener {
	private readonly microphone: Microphone;
	private readonly scribe: Scribe;
	private readonly worker: Worker;
	private readonly speakers: Worker;
	private readonly finishTurn: () => boolean;
	private closing = false;

	private constructor(
		microphone: Microphone,
		scribe: Scribe,
		worker: Worker,
		speakers: Worker,
		finishTurn: () => boolean,
	) {
		this.microphone = microphone;
		this.scribe = scribe;
		this.worker = worker;
		this.speakers = speakers;
		this.finishTurn = finishTurn;
	}

	/**
	 * `floor`: how loud, in dBFS, a segment's loudest 0.1 s must be for it to
	 * count, asked as it is heard. Call it from a click, since it starts the
	 * page's audio.
	 */
	static async open(
		key: string,
		hearing: Hearing,
		floor: () => number,
	): Promise<Listener> {
		let listener: Listener | null = null;
		/** Whether the segment in progress counts. */
		let speaking = false;
		/** The loudest 0.1 s of the segment in progress, in dBFS. */
		let loudest = Number.NEGATIVE_INFINITY;
		/** What Scribe committed of the segment in progress. */
		let pieces: string[] = [];
		/** Their words, timed. */
		let words: Word[] = [];
		/** Seconds of audio heard since the listener opened. */
		let clock = 0;
		/** Where the stretch of speech in progress starts, as far as the
		 * speaker model has not heard it yet. */
		let open: number | null = null;
		/** The stretches of the segments in progress, with their voices. */
		let stretches: Stretch[] = [];
		/** The stretches the speaker model is still to answer, in order. */
		const embedding: { from: number; to: number; done: () => void }[] = [];
		/** Once the speaker model answered everything asked so far. */
		let embedded: Promise<void> = Promise.resolve();
		let voicing = false;
		const voices = new Voices(`voice-voices ${location.href}`);
		const speakers = new SpeakersWorker();
		const ask = (message: ToSpeakers, transfer: Transferable[] = []) =>
			speakers.postMessage(message, transfer);
		const embed = (from: number, to: number) => {
			if (!voicing) return;
			// A short one is heard with the sound around it.
			const short = Math.max(0, SHORTEST - (to - from)) / 2;
			ask({ type: "embed", from: from - short, to: to + short });
			embedded = new Promise((done) => embedding.push({ from, to, done }));
		};
		speakers.onmessage = ({ data }: MessageEvent<FromSpeakers>) => {
			if (data.type === "ready") voicing = true;
			else if (data.type === "failed") {
				voicing = false;
				hearing.trace("voice.failed", { error: data.error });
				for (const { done } of embedding.splice(0)) done();
			} else {
				const asked = embedding.shift();
				if (!asked) return;
				const { from, to, done } = asked;
				if (data.embedding.some((x) => x !== 0)) {
					const { stretch, similarity } = voices.stretch(
						from,
						to,
						data.embedding,
					);
					stretches.push(stretch);
					hearing.trace("voice", {
						from,
						to,
						voice: stretch.voice,
						similarity,
					});
				}
				done();
			}
		};
		/** The commits not yet answered, in order. */
		const commits: Commit[] = [];
		/** Whether turn detection hears a turn in progress. */
		let turn = false;
		/** Whether a pause committed all the person said of the turn so far. */
		let settled = false;
		/** The chunks turn detection has not heard yet, in order. */
		const unheard: Int16Array[] = [];
		/** How many of the chunks turn detection is still to hear Scribe heard
		 * already, as the person ended the turn by hand. */
		let early = 0;
		const hear = (pcm: Int16Array) => {
			scribe.hear(pcm);
			if (!turn && commits.length === 0 && scribe.uncommitted >= BETWEEN)
				commit("between");
		};
		const fail = (error: Error) => {
			if (listener === null || listener.closing) return;
			listener.close();
			hearing.failed(error);
		};
		const worker = new TurnsWorker();
		const tell = (message: ToTurns, transfer: Transferable[] = []) =>
			worker.postMessage(message, transfer);
		const segment = () => {
			const counts = speaking || loudest >= floor();
			const text = pieces.join(" ").trim();
			const timed = words;
			speaking = false;
			loudest = Number.NEGATIVE_INFINITY;
			pieces = [];
			words = [];
			const tagged = () => {
				const said =
					timed.length > 0 ? annotate(timed, stretches, voices) : text;
				// What is left belongs to the segments still to come.
				const end = timed.at(-1)?.end;
				if (end !== undefined) stretches = stretches.filter((s) => s.to > end);
				hearing.segment(counts ? said : "");
			};
			if (!counts || embedding.length === 0) tagged();
			else embedded.then(tagged);
		};
		/** Ends the segment in progress once Scribe settled it; whether it is still to come. */
		const finish = (): boolean => {
			turn = false;
			const covered = settled;
			settled = false;
			if (!covered && scribe.commit()) commits.push("end");
			else if (commits.length > 0) commits[commits.length - 1] = "end";
			else return false;
			return true;
		};
		const commit = (why: Commit) => {
			if (scribe.commit()) commits.push(why);
		};
		const ready = new Promise<void>((resolve, reject) => {
			worker.onmessage = ({ data }: MessageEvent<FromTurns>) => {
				switch (data.type) {
					case "ready":
						return resolve();
					case "heard": {
						if (early > 0) {
							early--;
							return;
						}
						const pcm = unheard.shift();
						if (pcm) hear(pcm);
						return;
					}
					case "failed":
						reject(new Error(`Turn detection failed: ${data.error}`));
						return fail(new Error(`Turn detection failed: ${data.error}`));
					case "speech":
						open = data.at;
						turn = true;
						settled = false;
						hearing.trace("vad.speech", { at: data.at });
						if (loudest >= floor()) hearing.voiced(true);
						return;
					case "silence":
						if (open !== null) embed(open, data.at);
						open = null;
						hearing.trace("vad.silence", { at: data.at });
						hearing.voiced(false);
						return;
					case "verdict":
						return hearing.trace("turn.verdict", {
							probability: data.probability,
						});
					case "ending":
						hearing.trace("turn.ending", { reason: data.reason });
						if (turn && scribe.commit()) {
							commits.push("piece");
							settled = true;
						}
						return;
					case "ended":
						hearing.trace("turn.end", { reason: data.reason });
						if (!finish()) segment();
						return;
				}
			};
			worker.onerror = (event) => {
				reject(new Error(`Turn detection failed: ${event.message}`));
				fail(new Error(`Turn detection failed: ${event.message}`));
			};
		});
		let scribe: Scribe;
		try {
			[scribe] = await Promise.all([
				Scribe.open(
					key,
					{
						partial: (text) => {
							// It belongs to a segment being committed.
							if (commits.length > 0) return;
							const heard = [...pieces, text].join(" ").trim();
							tell({ type: "text", text: heard });
							if (!/\w/.test(text)) return;
							if (!speaking && loudest < floor()) return;
							if (!speaking) hearing.speaking();
							speaking = true;
							hearing.partial(heard);
						},
						committed: (text, automatic, timed) => {
							const why = automatic ? "piece" : (commits.shift() ?? "piece");
							// Where the words don't spell the text, the text is one word,
							// so that the tags never lose any of it.
							const spelled =
								timed
									.map((w) => w.text)
									.join("")
									.trim() === text.trim();
							hearing.trace("committed", { why, text, spelled });
							if (why !== "between" && text.trim()) {
								pieces.push(text.trim());
								const start = timed[0]?.start ?? clock;
								const end = timed.at(-1)?.end ?? clock;
								if (words.length > 0)
									words.push({ text: " ", start, end: start });
								if (spelled) words.push(...timed);
								else words.push({ text: text.trim(), start, end });
							}
							if (why === "end") segment();
							else if (turn) {
								// What a pause settled replaces its partial.
								const heard = pieces.join(" ");
								tell({ type: "text", text: heard });
								if (speaking) hearing.partial(heard);
							}
						},
						closed: (error) => {
							if (error) fail(error);
						},
					},
					navigator.languages,
				),
				ready,
			]);
		} catch (error) {
			worker.terminate();
			speakers.terminate();
			throw error;
		}
		let microphone: Microphone;
		try {
			microphone = await Microphone.open(
				(pcm) => {
					hearing.audio(pcm);
					unheard.push(pcm);
					const heard = pcm.slice();
					ask({ type: "audio", pcm: heard.buffer }, [heard.buffer]);
					clock += pcm.length / LISTEN_RATE;
					if (open !== null && clock - open >= STRETCH) {
						embed(open, open + STRETCH);
						open += STRETCH;
					}
					const rms = root(pcm);
					loudest = Math.max(loudest, 20 * Math.log10(rms));
					hearing.level(Math.min(1, rms * 8));
					const copy = pcm.slice();
					tell({ type: "audio", pcm: copy.buffer }, [copy.buffer]);
				},
				() => fail(new Error("The microphone was cut off.")),
			);
		} catch (error) {
			scribe.close();
			worker.terminate();
			speakers.terminate();
			throw error;
		}
		listener = new Listener(microphone, scribe, worker, speakers, () => {
			tell({ type: "end" });
			if (open !== null) embed(open, clock);
			open = null;
			// Everything said up to the person's end belongs to the turn.
			for (const pcm of unheard.splice(0)) {
				scribe.hear(pcm);
				early++;
			}
			const coming = finish();
			if (!coming) {
				speaking = false;
				loudest = Number.NEGATIVE_INFINITY;
				pieces = [];
				words = [];
			}
			return coming;
		});
		return listener;
	}

	/** Ends the segment in progress now, rather than once the person sounds
	 * done; whether its end is still to come. */
	finish(): boolean {
		return this.finishTurn();
	}

	close(): void {
		this.closing = true;
		this.microphone.close();
		this.scribe.close();
		this.worker.terminate();
		this.speakers.terminate();
	}
}

/** The root mean square of a chunk, from 0 to 1. */
function root(pcm: Int16Array): number {
	let sum = 0;
	for (const sample of pcm) sum += (sample / 32768) ** 2;
	return Math.sqrt(sum / pcm.length);
}
