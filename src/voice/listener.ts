// The listener: what the person says, as text, from the microphone through
// a transcriber, ElevenLabs' or a local one. Turn detection runs in the
// page, on local models, and ends a
// segment once the person sounds done; whether a segment ends the person's
// turn is for whoever uses the listener to decide. A segment counts only
// once it is loud enough, and only if its words are not the speaker's own,
// so that the speaker's echo, which the browser's echo cancellation never
// removes entirely and at times not at all, is not taken for the person.
// The transcriber hears each chunk once turn detection has, so that a commit at what
// turn detection marks lands where it marked it, and only from shortly
// before speech starts until its turn ends, so that the silence between
// turns is not paid for. Each stretch of speech is tagged by its voice, on a
// local speaker model, and a segment's words by the voice of their stretch,
// which it waits for if the model is not done. While speech goes on, the
// model also tells which known voice is heard now, if any.
import { Microphone } from "./audio.ts";
import {
	type Heard,
	LISTEN_RATE,
	type Transcriber,
	type Word,
} from "./engines.ts";
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
	/** The voice heard now, while speech goes on: its number, null for one
	 * close to no voice heard before or that has no number yet. */
	voice(number: number | null): void;
	/** What was heard so far of the segment in progress. */
	partial(text: string): void;
	/** A segment ended, empty if it held no words or never counted. */
	segment(text: string): void;
	/** A segment's words that didn't count, as the speaker's echo or too quiet
	 * while it played, which may still be the person's. */
	missed(text: string, echoed: boolean): void;
	/** What the microphone hears, as the transcriber gets it, before it goes on. */
	audio(pcm: Int16Array): void;
	/** How loud the microphone is, from 0 to 1, every 0.1 s. */
	level(level: number): void;
	/** The listener stopped on its own. */
	failed(error: Error): void;
	/** What turn detection decided, for the trace. */
	trace(event: string, data: Record<string, unknown>): void;
};

/** How long before turn detection hears speech start the transcriber hears it, in
 * seconds, so that a soft start, which voice activity hears late, is kept. */
const PREROLL = 0.5;
/** How much sound turn detection heard is kept for the next speech, in
 * seconds: the pre-roll, and where speech starts before it is heard. */
const KEPT = PREROLL + 0.5;

/** The longest stretch the speaker model hears at once, in seconds, so that
 * a long one is heard while it goes on, and a voice change inside it shows. */
const STRETCH = 10;

/** How long speech goes on, in seconds, before the speaker model is asked
 * which voice is heard now, how often it is asked again while it goes on,
 * and the longest it hears for it. */
const PROBE = { first: 0.75, every: 0.5, longest: 1.5 };

/** What a commit is for: a piece of the turn in progress, or its end. A
 * pause commits a piece shortly before it ends the turn, so that the turn's
 * words are settled by then. */
type Commit = "piece" | "end";

export class Listener {
	private readonly microphone: Microphone;
	private readonly transcriber: Transcriber;
	private readonly worker: Worker;
	private readonly speakers: Worker;
	private readonly finishTurn: () => boolean;
	private closing = false;

	private constructor(
		microphone: Microphone,
		transcriber: Transcriber,
		worker: Worker,
		speakers: Worker,
		finishTurn: () => boolean,
	) {
		this.microphone = microphone;
		this.transcriber = transcriber;
		this.worker = worker;
		this.speakers = speakers;
		this.finishTurn = finishTurn;
	}

	/**
	 * `floor`: how loud, in dBFS, a segment's speech must get in some 0.1 s
	 * for it to count, asked as each 0.1 s is heard. `echo`: whether words
	 * heard are the speaker's own, which never count. `gate`: whether what
	 * the microphone hears goes on, asked for each chunk: the microphone
	 * stays open while it is shut, so that opening it again needs no
	 * permission and takes no time, and nothing it hears goes anywhere. Call
	 * it from a click, since it starts the page's audio.
	 */
	static async open(
		/** Opens the transcriber, which tells `heard` what it hears. */
		transcribe: (heard: Heard) => Promise<Transcriber>,
		hearing: Hearing,
		floor: () => number,
		echo: (text: string) => boolean,
		gate: () => boolean,
	): Promise<Listener> {
		let listener: Listener | null = null;
		/** Whether the segment in progress counts. */
		let speaking = false;
		/** How loud each chunk the microphone heard is, in dBFS, against the
		 * floor in force as it was heard, back to what speech may still claim. */
		const levels: Level[] = [];
		/** Where turn detection heard speech in the segments in progress, the
		 * last without an end while speech goes on. */
		let spoken: { from: number; to: number }[] = [];
		/** The loudest chunk of the speech of the segments in progress, against
		 * its floor: a segment counts only by its own speech, at the floor in
		 * force as it was heard, not by a sound before it or a floor since. */
		const loudest = (): Level | null => {
			let top: Level | null = null;
			for (const level of levels)
				if (
					spoken.some(({ from, to }) => level.to > from && level.from < to) &&
					(top === null || above(level) > above(top))
				)
					top = level;
			return top;
		};
		const loud = (): boolean => {
			const top = loudest();
			return top !== null && above(top) >= 0;
		};
		/** Where each segment still to come ends, in order, in seconds of what
		 * turn detection heard. */
		const ends: number[] = [];
		/** Lets go of the speech of a segment that ended at `end`: what is still
		 * going on, or started since, belongs to the next. */
		const forget = (end: number) => {
			spoken = spoken.filter(
				({ from, to }) => from >= end || to === Number.POSITIVE_INFINITY,
			);
		};
		/** What the transcriber committed of the segment in progress. */
		let pieces: string[] = [];
		/** Their words, timed. */
		let words: Word[] = [];
		/** Seconds of audio heard since the listener opened. */
		let clock = 0;
		/** Where the stretch of speech in progress starts, as far as the
		 * speaker model has not heard it yet. */
		let open: number | null = null;
		/** Where the speech in progress starts, and where it was last asked
		 * which voice is heard. */
		let since: number | null = null;
		let probed: number | null = null;
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
			} else if (data.type === "probe") {
				if (!data.embedding.some((x) => x !== 0)) return;
				const { voice, similarity } = voices.closest(data.embedding);
				const number = voice === null ? null : voices.numbered(voice);
				hearing.trace("voice.now", { voice: number, similarity });
				hearing.voice(number);
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
					// `voice` is the number the message tags, as in `voice.now`,
					// null until its words are tagged; `index` is the stretch's voice.
					hearing.trace("voice", {
						from,
						to,
						voice:
							stretch.voice === null ? null : voices.numbered(stretch.voice),
						index: stretch.voice,
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
		/** How many of the chunks turn detection is still to hear the transcriber heard
		 * already, as the person ended the turn by hand. */
		let early = 0;
		/** Whether turn detection hears speech. */
		let voiced = false;
		/** Whether the transcriber hears what turn detection heard: from speech until
		 * the turn it starts ends, pauses included, since the transcriber gives a word's
		 * text only once it heard some of what follows. */
		let transcribing = false;
		/** Seconds of audio turn detection heard. */
		let passed = 0;
		/** The sound turn detection heard last, while it heard no speech, with
		 * where each chunk starts, for the transcriber to hear once speech starts. */
		const kept: { pcm: Int16Array; at: number }[] = [];
		/** Gives the transcriber the chunk turn detection heard next, or keeps it. */
		const hear = (pcm: Int16Array) => {
			const at = passed;
			passed += pcm.length / LISTEN_RATE;
			if (transcribing) return transcriber.hear(pcm);
			kept.push({ pcm, at });
			while ((kept[0]?.at ?? passed) < passed - KEPT)
				transcriber.skip(kept.shift()?.pcm.length ?? 0);
		};
		const fail = (error: Error) => {
			if (listener === null || listener.closing) return;
			listener.close();
			hearing.failed(error);
		};
		const worker = new TurnsWorker();
		const tell = (message: ToTurns, transfer: Transferable[] = []) =>
			worker.postMessage(message, transfer);
		/** Ends the segment that ended at `end`, in seconds of what turn
		 * detection heard. */
		const segment = (end: number) => {
			const text = pieces.join(" ").trim();
			const echoed = echo(text);
			if (echoed) hearing.trace("echo", { text });
			const counts = (speaking || loud()) && !echoed;
			if (!counts && !echoed && /\w/.test(text)) {
				const top = loudest();
				hearing.trace("quiet", {
					text,
					loudest: top?.loudness ?? null,
					floor: top?.floor ?? null,
				});
			}
			if (!counts && /\w/.test(text)) hearing.missed(text, echoed);
			const timed = words;
			speaking = false;
			forget(end);
			pieces = [];
			words = [];
			const tagged = () => {
				// What doesn't count is no voice's.
				const said =
					counts && timed.length > 0
						? annotate(timed, stretches, voices)
						: text;
				// What is left belongs to the segments still to come.
				const end = timed.at(-1)?.end;
				if (end !== undefined) stretches = stretches.filter((s) => s.to > end);
				hearing.segment(counts ? said : "");
			};
			if (!counts || embedding.length === 0) tagged();
			else embedded.then(tagged);
		};
		/** Ends the segment in progress once the transcriber settled it; whether it is still to come. */
		const finish = (): boolean => {
			turn = false;
			const covered = settled;
			settled = false;
			ends.push(passed);
			if (!covered && transcriber.commit()) commits.push("end");
			else if (commits.length > 0) commits[commits.length - 1] = "end";
			else {
				ends.pop();
				return false;
			}
			return true;
		};
		const ready = new Promise<void>((resolve, reject) => {
			worker.onmessage = ({ data }: MessageEvent<FromTurns>) => {
				switch (data.type) {
					case "ready":
						return resolve();
					case "heard": {
						if (early > 0) {
							// Turn detection now heard the person's end, after which only
							// speech going on continues a turn.
							if (--early === 0) transcribing = voiced;
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
						voiced = true;
						transcribing = true;
						for (const { pcm, at } of kept.splice(0))
							if (at + pcm.length / LISTEN_RATE > data.at - PREROLL)
								transcriber.hear(pcm);
							else transcriber.skip(pcm.length);
						open = data.at;
						since = data.at;
						probed = null;
						turn = true;
						settled = false;
						spoken.push({ from: data.at, to: Number.POSITIVE_INFINITY });
						hearing.trace("vad.speech", { at: data.at });
						if (loud()) hearing.voiced(true);
						return;
					case "silence":
						voiced = false;
						for (const stretch of spoken)
							if (stretch.to === Number.POSITIVE_INFINITY) stretch.to = data.at;
						if (open !== null) embed(open, data.at);
						open = null;
						since = null;
						hearing.trace("vad.silence", { at: data.at });
						hearing.voiced(false);
						return;
					case "verdict":
						return hearing.trace("turn.verdict", {
							probability: data.probability,
						});
					case "ending":
						hearing.trace("turn.ending", { reason: data.reason });
						if (turn && transcriber.commit()) {
							commits.push("piece");
							settled = true;
						}
						return;
					case "ended":
						hearing.trace("turn.end", { reason: data.reason });
						transcribing = false;
						if (!finish()) segment(passed);
						return;
				}
			};
			worker.onerror = (event) => {
				reject(new Error(`Turn detection failed: ${event.message}`));
				fail(new Error(`Turn detection failed: ${event.message}`));
			};
		});
		let transcriber: Transcriber;
		try {
			[transcriber] = await Promise.all([
				transcribe({
					partial: (text) => {
						// It belongs to a segment being committed.
						if (commits.length > 0) return;
						const heard = [...pieces, text].join(" ").trim();
						tell({ type: "text", text: heard });
						if (!/\w/.test(text)) return;
						if (!speaking && (!loud() || echo(heard))) return;
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
						hearing.trace("committed", {
							why,
							text,
							spelled,
							sent: transcriber.sent / LISTEN_RATE,
						});
						if (text.trim()) {
							pieces.push(text.trim());
							const start = timed[0]?.start ?? clock;
							const end = timed.at(-1)?.end ?? clock;
							if (words.length > 0)
								words.push({ text: " ", start, end: start });
							if (spelled) words.push(...timed);
							else words.push({ text: text.trim(), start, end });
						}
						if (why === "end") segment(ends.shift() ?? passed);
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
				}),
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
					if (!gate()) return;
					hearing.audio(pcm);
					unheard.push(pcm);
					const heard = pcm.slice();
					ask({ type: "audio", pcm: heard.buffer }, [heard.buffer]);
					clock += pcm.length / LISTEN_RATE;
					if (
						voicing &&
						since !== null &&
						clock >= (probed ?? since + PROBE.first - PROBE.every) + PROBE.every
					) {
						const from = Math.max(since, clock - PROBE.longest);
						ask({ type: "probe", from, to: clock });
						probed = clock;
					}
					if (open !== null && clock - open >= STRETCH) {
						embed(open, open + STRETCH);
						open += STRETCH;
					}
					const rms = root(pcm);
					levels.push({
						from: clock - pcm.length / LISTEN_RATE,
						to: clock,
						loudness: 20 * Math.log10(rms),
						floor: floor(),
					});
					// What turn detection may still hear as the start of speech.
					const claimed = Math.min(
						passed - KEPT,
						...spoken.map(({ from }) => from),
					);
					while ((levels[0]?.to ?? claimed) < claimed) levels.shift();
					hearing.level(Math.min(1, rms * 8));
					const copy = pcm.slice();
					tell({ type: "audio", pcm: copy.buffer }, [copy.buffer]);
				},
				() => fail(new Error("The microphone was cut off.")),
			);
		} catch (error) {
			transcriber.close();
			worker.terminate();
			speakers.terminate();
			throw error;
		}
		listener = new Listener(microphone, transcriber, worker, speakers, () => {
			tell({ type: "end" });
			if (open !== null) embed(open, clock);
			open = null;
			// Everything said up to the person's end belongs to the turn.
			if (voiced)
				for (const pcm of unheard.splice(0)) {
					hear(pcm);
					early++;
				}
			if (early === 0) transcribing = voiced;
			const coming = finish();
			if (!coming) {
				speaking = false;
				forget(passed);
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
		this.transcriber.close();
		this.worker.terminate();
		this.speakers.terminate();
	}
}

/** A chunk the microphone heard, from and to where in seconds, how loud it
 * is, and the floor in force as it was heard, both in dBFS. */
type Level = { from: number; to: number; loudness: number; floor: number };

/** How far a chunk is above its floor, in dB: without a floor, every chunk
 * is, a silent one too. */
function above({ loudness, floor }: Level): number {
	return floor === Number.NEGATIVE_INFINITY
		? Number.POSITIVE_INFINITY
		: loudness - floor;
}

/** The root mean square of a chunk, from 0 to 1. */
function root(pcm: Int16Array): number {
	let sum = 0;
	for (const sample of pcm) sum += (sample / 32768) ** 2;
	return Math.sqrt(sum / pcm.length);
}
