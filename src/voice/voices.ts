// Which voice said what: every stretch of speech gets the number of the voice
// it sounds like, the closest voice heard before if close enough, a new one
// otherwise, and the words of a segment are tagged by the voice of their
// stretch, as `[voice 1] ...`. The page doesn't know who a voice is.
// Embeddings are kept across reloads, so are voices' numbers.
import type { Word } from "./elevenlabs.ts";

/** How close an embedding must be to a voice's mean to be that voice, as
 * the cosine: on Luis's recordings, his stretches of a second or more are
 * all above 0.35 and other voices' below 0.25, and two videos' voices come
 * apart above 0.3. */
const SAME = 0.3;

/** A stretch of speech and its voice. */
export type Stretch = { from: number; to: number; voice: number };

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

	/** The number of a voice, given to it now if it has none. */
	number(voice: number): number {
		const given = this.numbers[voice];
		if (given != null) return given;
		const number = Math.max(0, ...this.numbers.map((n) => n ?? 0)) + 1;
		this.numbers[voice] = number;
		this.store();
		return number;
	}

	/** The voice of a unit-length embedding, and how close it is to it. */
	voice(embedding: Float32Array): { voice: number; similarity: number } {
		let best = -1;
		let similarity = Number.NEGATIVE_INFINITY;
		for (const [i, sum] of this.sums.entries()) {
			const s = dot(sum, embedding) / Math.sqrt(dot(sum, sum));
			if (s > similarity) [best, similarity] = [i, s];
		}
		if (similarity >= SAME) {
			const sum = this.sums[best] as Float32Array;
			for (let i = 0; i < sum.length; i++)
				sum[i] = (sum[i] ?? 0) + (embedding[i] ?? 0);
		} else {
			best = this.sums.length;
			this.sums.push(embedding.slice());
		}
		this.store();
		return { voice: best, similarity };
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
 * The words, each tagged by the voice of the stretch it lies in, or else of
 * the closest one, with a tag wherever the voice changes. Without stretches,
 * the words as they are.
 */
export function annotate(
	words: Word[],
	stretches: Stretch[],
	voices: Voices,
): string {
	let text = "";
	let last = -1;
	for (const word of words) {
		const voice = voiceAt((word.start + word.end) / 2, stretches) ?? last;
		if (voice !== last && /\w/.test(word.text)) {
			text = `${text.trimEnd()} [voice ${voices.number(voice)}] `;
			last = voice;
		}
		text += word.text;
	}
	return text.trim();
}

function voiceAt(time: number, stretches: Stretch[]): number | undefined {
	let closest: Stretch | undefined;
	let distance = Number.POSITIVE_INFINITY;
	for (const stretch of stretches) {
		const d = Math.max(stretch.from - time, time - stretch.to, 0);
		if (d < distance) [closest, distance] = [stretch, d];
	}
	return closest?.voice;
}

function dot(a: Float32Array, b: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
	return sum;
}
