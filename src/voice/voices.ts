// Which voice said what: every stretch of speech gets the number of the voice
// it sounds like, the closest voice heard before if close enough, a new one
// otherwise if it is long enough, and the words of a segment are tagged by the voice of their
// stretch, as `[voice 1] ...`. The page doesn't know who a voice is.
// Embeddings are kept across reloads, so are voices' numbers.
import type { Word } from "./elevenlabs.ts";

/** How close an embedding must be to a voice's mean to be that voice, as
 * the cosine: on Luis's recordings, his stretches of a second or more are
 * all above 0.35 and other voices' below 0.25, and two videos' voices come
 * apart above 0.3. */
const SAME = 0.3;

/** The shortest stretch of speech, in seconds, whose voice shows on its own:
 * a shorter one takes the voice of a longer one in its segment, and only
 * where there is none is it matched itself. */
export const SHORTEST = 1;

/** The shortest stretch, in seconds, that is heard as a new voice when it is
 * close to none: a shorter one, such as Luis's lone "um", or his "It means"
 * over 1.3 s at 0.2, is taken as short instead. */
const NEW = 2;

/** A stretch of speech, its embedding, and its voice, null for a short one
 * until its segment ends. */
export type Stretch = {
	from: number;
	to: number;
	embedding: Float32Array;
	voice: number | null;
};

/** The voices heard so far, kept across reloads under `key`. */
export class Voices {
	private readonly key: string;
	/** Each voice's sum of embeddings. */
	private readonly sums: Float32Array[];
	/** Each voice's number, once its words were tagged, so that the numbers
	 * the agent sees count up from 1 without gaps. */
	private readonly numbers: (number | null)[];

	constructor(key: string) {
		this.key = key;
		const stored = JSON.parse(localStorage.getItem(key) ?? "{}") as {
			sums?: number[][];
			numbers?: (number | null)[];
		};
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
		this.store();
		return number;
	}

	/** A stretch, with its voice if it is long enough to show, and how close
	 * it is to that voice. */
	stretch(
		from: number,
		to: number,
		embedding: Float32Array,
	): { stretch: Stretch; similarity?: number } {
		if (to - from < SHORTEST)
			return { stretch: { from, to, embedding, voice: null } };
		const { voice, similarity } = this.closest(embedding);
		if (voice === null && to - from < NEW)
			return { stretch: { from, to, embedding, voice: null }, similarity };
		return {
			stretch: { from, to, embedding, voice: this.voice(embedding) },
			similarity,
		};
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
			this.store();
			return this.sums.length - 1;
		}
		const sum = this.sums[voice] as Float32Array;
		for (let i = 0; i < sum.length; i++)
			sum[i] = (sum[i] ?? 0) + (embedding[i] ?? 0);
		this.store();
		return voice;
	}

	/** The voice closest to a short stretch heard on its own: the closest
	 * one, however far, or a new one if there is none yet. */
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

	private store(): void {
		const sums = this.sums.map((sum) => Array.from(sum));
		localStorage.setItem(
			this.key,
			JSON.stringify({ sums, numbers: this.numbers }),
		);
	}
}

/**
 * The words of a segment, each tagged by the voice of the stretch it lies
 * in, or else of the closest one, with a tag wherever the voice changes.
 * Without stretches, the words as they are.
 */
export function annotate(
	words: Word[],
	all: Stretch[],
	voices: Voices,
): string {
	const from = (words[0]?.start ?? 0) - 1;
	const to = (words.at(-1)?.end ?? 0) + 1;
	const stretches = all.filter((s) => s.to > from && s.from < to);
	const long = stretches.filter((s) => s.voice !== null);
	for (const s of stretches)
		if (s.voice === null)
			s.voice =
				long.length > 0
					? voiceAt((s.from + s.to) / 2, long)
					: voices.guess(s.embedding);
	let text = "";
	let last = -1;
	for (const word of words) {
		const voice = voiceAt((word.start + word.end) / 2, stretches) ?? last;
		if (voice < 0) {
			text += word.text;
			continue;
		}
		if (voice !== last && /\w/.test(word.text)) {
			text = `${text.trimEnd()} [voice ${voices.number(voice)}] `;
			last = voice;
		}
		text += word.text;
	}
	return text.trim();
}

function voiceAt(time: number, stretches: Stretch[]): number | null {
	let closest: Stretch | undefined;
	let distance = Number.POSITIVE_INFINITY;
	for (const stretch of stretches) {
		const d = Math.max(stretch.from - time, time - stretch.to, 0);
		if (d < distance) [closest, distance] = [stretch, d];
	}
	return closest?.voice ?? null;
}

function dot(a: Float32Array, b: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
	return sum;
}
