// Which voice said what: every stretch of speech gets the number of the voice
// it sounds like, the closest voice heard before if close enough, a new one
// otherwise if it is long enough, and the words of a segment are tagged by the voice of their
// stretch, as `[voice 1] ...`. The page doesn't know who a voice is, except
// for the voices the speaker plays, which it hears as they are played: the
// agent's, whose echo through the microphone is thus known by its sound.
// Embeddings are kept across reloads, so are voices' numbers, as long as the
// fingerprint model stays the same.
import type { Word } from "./engines.ts";
import { REDIMNET2 } from "./models.ts";

/** How close an embedding must be to a voice's mean to be that voice, as
 * the cosine: on LibriSpeech, 1% of other voices' stretches of a second come
 * this close, fewer of longer ones and on VoxCeleb, and in Luis's live
 * tests every stretch and probe of his own came closer, at 0.39 or above. */
const SAME = 0.38;

/** The shortest stretch of speech, in seconds, whose voice shows on its own:
 * a shorter one takes the voice of a longer one in its segment, and only
 * where there is none is it matched itself. */
export const SHORTEST = 1;

/** The shortest stretch, in seconds, that is heard as a new voice when it is
 * close to none: a shorter one, such as Luis's lone "um", or his "It means"
 * over 1.3 s at 0.2, is taken as short instead. */
const NEW = 2;

/** A stretch of speech, its embedding, whether the speaker sounded during
 * it, its voice, and whether it is the speaker's echo. A short one has
 * neither until its segment ends; echo has a voice only where it is close
 * enough to a voice the speaker played. */
export type Stretch = {
	from: number;
	to: number;
	embedding: Float32Array;
	sounding: boolean;
	voice: number | null;
	played: boolean;
};

/** The voices heard so far, kept across reloads under `key`. */
export class Voices {
	private readonly key: string;
	/** Each voice's sum of embeddings. */
	private readonly sums: Float32Array[];
	/** Each voice's number, once its words were tagged, so that the numbers
	 * the agent sees count up from 1 without gaps. */
	private readonly numbers: (number | null)[];
	/** Which voices the speaker played. */
	private readonly speakers: boolean[];

	constructor(key: string) {
		this.key = key;
		const kept = JSON.parse(localStorage.getItem(key) ?? "{}") as {
			model?: string;
			sums?: number[][];
			numbers?: (number | null)[];
			speakers?: boolean[];
		};
		// Another model's embeddings can't be compared with this one's.
		const stored = kept.model === REDIMNET2.integrity ? kept : {};
		this.sums = (stored.sums ?? []).map((sum) => Float32Array.from(sum));
		this.numbers = stored.numbers ?? [];
		this.speakers = stored.speakers ?? [];
	}

	/** Whether the speaker played a voice. */
	played(voice: number): boolean {
		return this.speakers[voice] ?? false;
	}

	/** Hears the embedding of speech the speaker played: as the voice the
	 * speaker played it is close enough to, a new one otherwise. Never as a
	 * voice the microphone heard alone, which would take the person's voice
	 * for the speaker's if the two sound alike. */
	play(embedding: Float32Array): void {
		const { best, similarity } = this.best(embedding, (v) => this.played(v));
		if (similarity >= SAME) {
			this.add(best, embedding);
			return;
		}
		this.speakers[this.sums.length] = true;
		this.sums.push(embedding.slice());
		this.store();
	}

	/** The number of a voice, if it was given one. */
	numbered(voice: number): number | null {
		return this.numbers[voice] ?? null;
	}

	/** The number of a voice, given to it now if it has none. Never one the
	 * speaker played, whose words are never sent. */
	number(voice: number): number {
		const given = this.numbers[voice];
		if (given != null) return given;
		// The numbers have holes where a voice has none yet, which `reduce`
		// skips and spreading would read as NaN.
		const number =
			this.numbers.reduce<number>((m, n) => Math.max(m, n ?? 0), 0) + 1;
		this.numbers[voice] = number;
		this.store();
		return number;
	}

	/** A stretch, with its voice if it is long enough to show, and how close
	 * it is to that voice. `sounding`: whether the speaker sounded during it. */
	stretch(
		from: number,
		to: number,
		embedding: Float32Array,
		sounding: boolean,
	): { stretch: Stretch; similarity?: number } {
		const heard = { from, to, embedding, sounding };
		if (to - from < SHORTEST)
			return { stretch: { ...heard, voice: null, played: false } };
		const { voice, played, similarity } = this.closest(embedding, sounding);
		if (played) {
			if (voice !== null && similarity >= SAME) this.add(voice, embedding);
			return { stretch: { ...heard, voice, played }, similarity };
		}
		if (voice === null && to - from < NEW)
			return { stretch: { ...heard, voice: null, played }, similarity };
		return {
			stretch: { ...heard, voice: this.voice(embedding), played },
			similarity,
		};
	}

	/** The voice a unit-length embedding is close enough to, null for none,
	 * whether it is the speaker's echo, and how close it is to the closest
	 * voice, without hearing it as one. Echo is heard only while the speaker
	 * sounds, and then it is whatever is not close enough to a person's voice,
	 * and closer to it than to the voices the speaker played: the path from
	 * the speaker to the microphone changes how it sounds, far below `SAME` in
	 * the short pieces echo cancellation leaves of it. */
	closest(
		embedding: Float32Array,
		sounding = false,
	): { voice: number | null; played: boolean; similarity: number } {
		if (!sounding) {
			const { best, similarity } = this.best(embedding, (v) => !this.played(v));
			const voice = similarity >= SAME ? best : null;
			return { voice, played: false, similarity };
		}
		const { best, similarity } = this.best(embedding);
		if (similarity >= SAME && !this.played(best))
			return { voice: best, played: false, similarity };
		const voice = this.played(best) ? best : null;
		return { voice, played: true, similarity };
	}

	/** The voice of a unit-length embedding: the voice it is close enough to,
	 * a new one otherwise. */
	voice(embedding: Float32Array): number {
		const { voice } = this.closest(embedding);
		if (voice === null) {
			this.sums.push(embedding.slice());
			this.store();
			return this.sums.length - 1;
		}
		this.add(voice, embedding);
		return voice;
	}

	private add(voice: number, embedding: Float32Array): void {
		const sum = this.sums[voice] as Float32Array;
		for (let i = 0; i < sum.length; i++)
			sum[i] = (sum[i] ?? 0) + (embedding[i] ?? 0);
		this.store();
	}

	/** The voice of a short stretch heard on its own, and whether it is the
	 * speaker's echo: while the speaker sounds, as `closest` judges it;
	 * otherwise the closest person's voice, however far, or a new one if
	 * there is none yet. */
	guess(
		embedding: Float32Array,
		sounding: boolean,
	): { voice: number | null; played: boolean } {
		if (sounding) return this.closest(embedding, true);
		const { best } = this.best(embedding, (v) => !this.played(v));
		return { voice: best >= 0 ? best : this.voice(embedding), played: false };
	}

	private best(
		embedding: Float32Array,
		among: (voice: number) => boolean = () => true,
	): { best: number; similarity: number } {
		let best = -1;
		let similarity = Number.NEGATIVE_INFINITY;
		for (const [i, sum] of this.sums.entries()) {
			if (!among(i)) continue;
			const s = dot(sum, embedding) / Math.sqrt(dot(sum, sum));
			if (s > similarity) [best, similarity] = [i, s];
		}
		return { best, similarity };
	}

	private store(): void {
		const sums = this.sums.map((sum) => Array.from(sum));
		localStorage.setItem(
			this.key,
			JSON.stringify({
				model: REDIMNET2.integrity,
				sums,
				numbers: this.numbers,
				speakers: this.speakers,
			}),
		);
	}
}

/** Words said in one voice, null for words no stretch was heard for, and
 * whether the speaker played it. */
export type Run = { voice: number | null; played: boolean; text: string };

/**
 * The words of a segment, split where the voice changes, each by the voice
 * of the stretch it lies in, or else of the closest one. Without
 * stretches, the words as they are.
 */
export function runs(words: Word[], all: Stretch[], voices: Voices): Run[] {
	const from = (words[0]?.start ?? 0) - 1;
	const to = (words.at(-1)?.end ?? 0) + 1;
	const stretches = all.filter((s) => s.to > from && s.from < to);
	const undecided = (s: Stretch) => s.voice === null && !s.played;
	const decided = stretches.filter((s) => !undecided(s));
	for (const s of stretches.filter(undecided)) {
		const { voice, played } =
			at((s.from + s.to) / 2, decided) ?? voices.guess(s.embedding, s.sounding);
		[s.voice, s.played] = [voice, played];
	}
	const runs: Run[] = [];
	let run: Run = { voice: null, played: false, text: "" };
	for (const word of words) {
		const { voice, played } = at((word.start + word.end) / 2, stretches) ?? run;
		if (
			(voice !== run.voice || played !== run.played) &&
			/\w/.test(word.text)
		) {
			// What has no word yet goes with the words after it.
			const carried = /\w/.test(run.text) ? "" : run.text;
			if (!carried) runs.push(run);
			run = { voice, played, text: carried };
		}
		run.text += word.text;
	}
	runs.push(run);
	return runs
		.map((r) => ({ ...r, text: r.text.trim() }))
		.filter((r) => r.text !== "");
}

/** Runs as the agent reads them: each voice's words after its tag, as
 * `[voice 1] ...`, where the voice changes. */
export function tag(runs: Run[], voices: Voices): string {
	let text = "";
	let last: number | null = null;
	for (const { voice, text: said } of runs) {
		if (voice !== null && voice !== last)
			text += ` [voice ${voices.number(voice)}]`;
		if (voice !== null) last = voice;
		text += ` ${said}`;
	}
	return text.trim();
}

/** The stretch a time lies in, or else the closest one. */
function at(time: number, stretches: Stretch[]): Stretch | undefined {
	let closest: Stretch | undefined;
	let distance = Number.POSITIVE_INFINITY;
	for (const stretch of stretches) {
		const d = Math.max(stretch.from - time, time - stretch.to, 0);
		if (d < distance) [closest, distance] = [stretch, d];
	}
	return closest;
}

function dot(a: Float32Array, b: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
	return sum;
}
