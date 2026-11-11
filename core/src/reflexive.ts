// Hearing on the core's own reflexes, for a tier that only transcribes, such
// as the local one: turn detection, on local models, ends a segment once the
// speech sounds done, and the voice fingerprint tags each stretch of speech
// by its voice, and a segment's words by the voice of their stretch, which
// it waits for if the model is not done. While speech goes on, the model also
// tells which known voice is heard now, if any. The model hears what the
// speaker plays too, so that its voice is known, and its echo as its own.
// The transcriber hears each chunk once turn detection has, so that a commit
// at what turn detection marks lands where it marked it, and only from
// shortly before speech starts until its turn ends, so that the silence
// between turns is not paid for.
import type { Reflexes, ToFingerprints, ToTurns } from "./reflexes.ts";
import type { Store } from "./store.ts";
import {
	type Hearer,
	LISTEN_RATE,
	type Listen,
	type Transcribe,
	type Transcriber,
	type Word,
} from "./tier.ts";
import { runs, SHORTEST, type Stretch, Voices } from "./voices.ts";

/** How long before turn detection hears speech start the transcriber hears it, in
 * seconds, so that a soft start, which voice activity hears late, is kept. */
const PREROLL = 0.5;
/** How much sound turn detection heard is kept for the next speech, in
 * seconds: the pre-roll, and where speech starts before it is heard. */
const KEPT = PREROLL + 0.5;

/** The longest stretch the fingerprint model hears at once, in seconds, so that
 * a long one is heard while it goes on, and a voice change inside it shows. */
const STRETCH = 10;

/** How long speech goes on, in seconds, before the fingerprint model is asked
 * which voice is heard now, how often it is asked again while it goes on,
 * and the longest it hears for it. */
const PROBE = { first: 0.75, every: 0.5, longest: 1.5 };

/** What a commit is for: a piece of the turn in progress, or its end. A
 * pause commits a piece shortly before it ends the turn, so that the turn's
 * words are settled by then. */
type Commit = "piece" | "end";

/** Hearing with `transcribe`, on the reflexes, keeping the voices in `store`. */
export function reflexive(
	transcribe: Transcribe,
	reflexes: Reflexes,
	store: Store,
): Listen {
	return async (heard) => {
		/** Whether hearing opened, and whether it is closing since. */
		let opened = false;
		let closing = false;
		/** What the transcriber committed of the segment in progress. */
		let pieces: string[] = [];
		/** Their words, timed. */
		let words: Word[] = [];
		/** Where the segment in progress started being spoken, in seconds. */
		let began: number | null = null;
		/** Seconds of audio heard since listening opened. */
		let clock = 0;
		/** Where the stretch of speech in progress starts, as far as the
		 * fingerprint model has not heard it yet. */
		let open: number | null = null;
		/** Where the speech in progress starts, and where it was last asked
		 * which voice is heard. */
		let since: number | null = null;
		let probed: number | null = null;
		/** The stretches of the segments in progress, with their voices. */
		let stretches: Stretch[] = [];
		/** The stretches the fingerprint model is still to answer, in order. */
		const embedding: {
			from: number;
			to: number;
			sounding: boolean;
			done: () => void;
		}[] = [];
		/** Where the speaker sounded, over the last minute, in seconds. */
		let sounded: { from: number; to: number }[] = [];
		/** Whether the speaker sounds now. */
		let sounding = false;
		/** Once the fingerprint model answered everything asked so far. */
		let embedded: Promise<void> = Promise.resolve();
		let voicing = false;
		const voices = new Voices(store);
		const speakers = reflexes.fingerprints();
		const ask = (message: ToFingerprints, transfer: ArrayBuffer[] = []) =>
			speakers.post(message, transfer);
		const embed = (from: number, to: number) => {
			if (!voicing) return;
			// A short one is heard with the sound around it.
			const short = Math.max(0, SHORTEST - (to - from)) / 2;
			ask({ type: "embed", from: from - short, to: to + short });
			const heard = sounded.some((s) => s.to > from && s.from < to);
			embedded = new Promise((done) =>
				embedding.push({ from, to, sounding: heard, done }),
			);
		};
		speakers.receive((data) => {
			if (data.type === "ready") voicing = true;
			else if (data.type === "failed") {
				voicing = false;
				heard.trace("voice.failed", { error: data.error });
				for (const { done } of embedding.splice(0)) done();
			} else if (data.type === "probe") {
				if (!data.embedding.some((x) => x !== 0)) return;
				const { voice, played, similarity } = voices.closest(
					data.embedding,
					sounding,
				);
				const number = voice === null ? null : voices.numbered(voice);
				heard.trace("voice.now", { voice: number, played, similarity });
				heard.voice(number, played);
			} else if (data.type === "played") {
				if (data.embedding.some((x) => x !== 0)) voices.play(data.embedding);
			} else {
				const asked = embedding.shift();
				if (!asked) return;
				const { from, to, sounding, done } = asked;
				if (data.embedding.some((x) => x !== 0)) {
					const { stretch, similarity } = voices.stretch(
						from,
						to,
						data.embedding,
						sounding,
					);
					stretches.push(stretch);
					// `voice` is the number the message tags, as in `voice.now`,
					// null until its words are tagged; `index` is the stretch's voice.
					heard.trace("voice", {
						from,
						to,
						voice:
							stretch.voice === null ? null : voices.numbered(stretch.voice),
						index: stretch.voice,
						played: stretch.played,
						similarity,
					});
				}
				done();
			}
		});
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
		const close = () => {
			closing = true;
			transcriber.close();
			worker.close();
			speakers.close();
		};
		const fail = (error: Error) => {
			// Before it opened, opening fails instead.
			if (!opened || closing) return;
			close();
			heard.failed(error);
		};
		const worker = reflexes.turns();
		const tell = (message: ToTurns, transfer: ArrayBuffer[] = []) =>
			worker.post(message, transfer);
		/** Ends the segment in progress, once its stretches have voices. */
		const segment = () => {
			const text = pieces.join(" ").trim();
			const timed = words;
			began = null;
			pieces = [];
			words = [];
			const report = () => {
				const said = /\w/.test(text)
					? timed.length > 0
						? runs(timed, stretches, voices)
						: [{ text, voice: null }]
					: [];
				// What is left belongs to the segments still to come.
				const end = timed.at(-1)?.end;
				if (end !== undefined) stretches = stretches.filter((s) => s.to > end);
				heard.segment(said);
			};
			if (embedding.length === 0) report();
			else embedded.then(report);
		};
		/** Ends the segment in progress once the transcriber settled it; whether it is still to come. */
		const finish = (): boolean => {
			turn = false;
			const covered = settled;
			settled = false;
			if (!covered && transcriber.commit()) commits.push("end");
			else if (commits.length > 0) commits[commits.length - 1] = "end";
			else return false;
			return true;
		};
		/** What was heard so far of the segment in progress, as one word timed
		 * from where it started being spoken. */
		const partial = (text: string) =>
			heard.partial([{ text, voice: null, start: began ?? undefined }]);
		const ready = new Promise<void>((resolve, reject) => {
			const failed = (error: Error) => {
				reject(new Error(`Turn detection failed: ${error.message}`));
				fail(new Error(`Turn detection failed: ${error.message}`));
			};
			worker.receive((data) => {
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
						return failed(new Error(data.error));
					case "speech":
						voiced = true;
						transcribing = true;
						for (const { pcm, at } of kept.splice(0))
							if (at + pcm.length / LISTEN_RATE > data.at - PREROLL)
								transcriber.hear(pcm);
							else transcriber.skip(pcm.length);
						transcriber.spoke(data.at);
						open = data.at;
						since = data.at;
						began ??= data.at;
						probed = null;
						turn = true;
						settled = false;
						heard.trace("vad.speech", { at: data.at });
						heard.voiced(true);
						return;
					case "silence":
						voiced = false;
						if (open !== null) embed(open, data.at);
						open = null;
						transcriber.paused(data.at);
						since = null;
						heard.trace("vad.silence", { at: data.at });
						heard.voiced(false);
						return;
					case "verdict":
						return heard.trace("turn.verdict", {
							probability: data.probability,
						});
					case "ending":
						heard.trace("turn.ending", { reason: data.reason });
						if (turn && transcriber.commit()) {
							commits.push("piece");
							settled = true;
						}
						return;
					case "ended":
						heard.trace("turn.end", { reason: data.reason });
						transcribing = false;
						if (!finish()) segment();
						return;
				}
			}, failed);
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
						if (/\w/.test(text)) partial(heard);
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
						heard.trace("committed", {
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
						if (why === "end") segment();
						else if (turn) {
							// What a pause settled replaces its partial.
							const heard = pieces.join(" ");
							tell({ type: "text", text: heard });
							if (/\w/.test(heard)) partial(heard);
						}
					},
					closed: (error) => {
						if (error) fail(error);
					},
				}),
				ready,
			]);
		} catch (error) {
			worker.close();
			speakers.close();
			throw error;
		}
		const hearer: Hearer = {
			hear: (pcm, now) => {
				unheard.push(pcm);
				const from = clock;
				const copy = pcm.slice();
				ask({ type: "audio", pcm: copy.buffer }, [copy.buffer]);
				clock += pcm.length / LISTEN_RATE;
				sounding = now;
				if (now) sounded.push({ from, to: clock });
				sounded = sounded.filter(({ to }) => to > clock - 60);
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
				const told = pcm.slice();
				tell({ type: "audio", pcm: told.buffer }, [told.buffer]);
			},
			played: (samples) => {
				const copy = samples.slice();
				ask({ type: "played", samples: copy.buffer }, [copy.buffer]);
			},
			finish: () => {
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
					began = null;
					pieces = [];
					words = [];
				}
				return coming;
			},
			close,
		};
		opened = true;
		return hearer;
	};
}
