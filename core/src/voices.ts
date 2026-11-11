// Which voice said what: every stretch of speech gets the number of the voice
// it sounds like, the closest voice heard before if close enough, a new one
// otherwise if it is long enough, and the words of a segment are tagged by
// the voice of their stretch. The core doesn't know who a voice is.
// Embeddings are kept in the store, so are voices' numbers, as long as the
// fingerprint model stays the same.
import { REDIMNET2 } from "./models.ts";
import type { Store } from "./store.ts";
import type { Said, Word } from "./tier.ts";

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

/** A stretch of speech, its embedding, and its voice: a short one has
 * none until its segment ends. */
export type Stretch = {
	from: number;
	to: number;
	embedding: Float32Array;
	voice: number | null;
};

/** Where the store keeps the voices. */
const KEY = "voices";

/** The voices heard so far, kept in a store. */
export class Voices {
	private readonly store: Store;
	/** Each voice's sum of embeddings. */
	private readonly sums: Float32Array[];
	/** Each voice's number, once its words were tagged, so that the numbers
	 * the agent sees count up from 1 without gaps. */
	private readonly numbers: (number | null)[];

	constructor(store: Store) {
		this.store = store;
		const kept = JSON.parse(store.get(KEY) ?? "{}") as {
			model?: string;
			sums?: number[][];
			numbers?: (number | null)[];
			speakers?: boolean[];
		};
		// Another model's embeddings can't be compared with this one's, and
		// the voices the speaker played, which were kept until 2026-11, are
		// no one's.
		const stored =
			kept.model === REDIMNET2.integrity && !kept.speakers?.some(Boolean)
				? kept
				: {};
		this.sums = (stored.sums ?? []).map((sum) => Float32Array.from(sum));
		this.numbers = stored.numbers ?? [];
	}

	/** The number of a voice, if it was given one. */
	numbered(voice: number): number | null {
		return this.numbers[voice] ?? null;
	}

	/** The number of a voice, given to it now if it has none. */
	number(voice: number): number {
		const given = this.numbers[voice];
		if (given != null) return given;
		// The numbers have holes where a voice has none yet, which `reduce`
		// skips and spreading would read as NaN.
		const number =
			this.numbers.reduce<number>((m, n) => Math.max(m, n ?? 0), 0) + 1;
		this.numbers[voice] = number;
		this.keep();
		return number;
	}

	/** A stretch, with its voice if it is long enough to show, and how close
	 * it is to that voice. */
	stretch(
		from: number,
		to: number,
		embedding: Float32Array,
	): { stretch: Stretch; similarity?: number } {
		const heard = { from, to, embedding };
		if (to - from < SHORTEST) return { stretch: { ...heard, voice: null } };
		const { voice, similarity } = this.closest(embedding);
		if (voice === null && to - from < NEW)
			return { stretch: { ...heard, voice: null }, similarity };
		return { stretch: { ...heard, voice: this.voice(embedding) }, similarity };
	}

	/** The voice a unit-length embedding is close enough to, null for none,
	 * and how close it is to the closest voice, without hearing it as one. */
	closest(embedding: Float32Array): {
		voice: number | null;
		similarity: number;
	} {
		const { best, similarity } = this.best(embedding);
		return { voice: similarity >= SAME ? best : null, similarity };
	}

	/** The voice of a unit-length embedding: the voice it is close enough to,
	 * a new one otherwise. */
	voice(embedding: Float32Array): number {
		const { voice } = this.closest(embedding);
		if (voice === null) {
			this.sums.push(embedding.slice());
			this.keep();
			return this.sums.length - 1;
		}
		const sum = this.sums[voice] as Float32Array;
		for (let i = 0; i < sum.length; i++)
			sum[i] = (sum[i] ?? 0) + (embedding[i] ?? 0);
		this.keep();
		return voice;
	}

	/** The voice of a short stretch heard on its own: the closest voice,
	 * however far, or a new one if there is none yet. */
	guess(embedding: Float32Array): number {
		const { best } = this.best(embedding);
		return best >= 0 ? best : this.voice(embedding);
	}

	private best(embedding: Float32Array): { best: number; similarity: number } {
		let best = -1;
		let similarity = Number.NEGATIVE_INFINITY;
		for (const [i, sum] of this.sums.entries()) {
			const s = dot(sum, embedding) / Math.sqrt(dot(sum, sum));
			if (s > similarity) [best, similarity] = [i, s];
		}
		return { best, similarity };
	}

	private keep(): void {
		const sums = this.sums.map((sum) => Array.from(sum));
		this.store.set(
			KEY,
			JSON.stringify({
				model: REDIMNET2.integrity,
				sums,
				numbers: this.numbers,
			}),
		);
	}
}

/**
 * The words of a segment, each tagged with the number of the voice of the
 * stretch it lies in, or else of the closest one, numbering the voices that
 * have none yet. Without stretches, the words untagged.
 */
export function runs(words: Word[], all: Stretch[], voices: Voices): Said[] {
	const from = (words[0]?.start ?? 0) - 1;
	const to = (words.at(-1)?.end ?? 0) + 1;
	const stretches = all.filter((s) => s.to > from && s.from < to);
	const decided = stretches.filter((s) => s.voice !== null);
	for (const s of stretches.filter((s) => s.voice === null))
		s.voice =
			at((s.from + s.to) / 2, decided)?.voice ?? voices.guess(s.embedding);
	return words.map(({ text, start, end }) => {
		const voice = at((start + end) / 2, stretches)?.voice ?? null;
		return {
			text,
			start,
			end,
			voice: voice === null ? null : voices.number(voice),
		};
	});
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
