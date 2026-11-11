// The listener: what is said, as text tagged by voice, from the person's
// audio through the tier's hearing, which ends each segment where it hears
// one end. The listener only perceives: what is done with a segment, such as
// whether it ends the person's turn, is for whoever uses it to decide.
// While the speaker plays, a segment counts only where its own speech got
// louder than a floor: the browser's echo cancellation leaves some of the
// speaker's echo, which stays below it.
import { type Hearer, LISTEN_RATE, type Listen, type Said } from "./tier.ts";

/** A segment as heard: its words, each tagged by voice, whether it got
 * louder than the floor, and whether it was said while the speaker played,
 * where a floor was in force. */
export type Segment = { words: Said[]; loud: boolean; sounding: boolean };

export type Hearing = {
	/** Speech starts, louder than the floor, or stops: a sound that may
	 * still turn out to be no words. */
	voiced(voiced: boolean): void;
	/** The person started saying words. */
	speaking(): void;
	/** The voice heard now, while speech goes on: its number, null for one
	 * that has no number yet. */
	voice(number: number | null): void;
	/** What was heard so far of the segment in progress, once it got louder
	 * than the floor. */
	partial(text: string): void;
	/** A segment ended, without words if it held none. */
	segment(segment: Segment): void;
	/** What the microphone hears, as the tier gets it, before it goes on. */
	audio(pcm: Int16Array): void;
	/** How loud the microphone is, from 0 to 1, every 0.1 s. */
	level(level: number): void;
	/** The listener stopped on its own. */
	failed(error: Error): void;
	/** What the tier decided, for the trace. */
	trace(event: string, data: Record<string, unknown>): void;
};

/** The person's audio, which the host opens as listening opens, and closes
 * as it closes. */
export type Input = {
	/** `cut`: the audio stopped on its own, as when the system takes the
	 * microphone. */
	open(cut: (error: Error) => void): Promise<void>;
	close(): void;
};

/** What the listener needs of where it runs. */
export type Surroundings = {
	input?: Input | undefined;
	/** How loud, in dBFS, a segment's speech must get in some 0.1 s for it to
	 * be loud, asked as each 0.1 s is heard. */
	floor: () => number;
};

/** How long the levels heard are kept, in seconds: longer than a segment. */
const KEPT = 60;
/** How far around a word its loudness is heard, in seconds, since a tier
 * times words only roughly. */
const AROUND = 0.15;
/** How far back speech that starts is heard for its loudness, in seconds. */
const ONSET = 0.5;

/** The words of a segment as text. */
export function text(words: Said[]): string {
	return words
		.map((w) => w.text)
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}

/** Words as the agent reads them: each voice's words after its tag, as
 * `[voice 1] ...`, where the voice changes. A word without a voice takes the
 * one before. */
export function tag(words: Said[]): string {
	let out = "";
	let last: number | null = null;
	for (const { text, voice } of words) {
		if (voice !== null && voice !== last && /\w/.test(text)) {
			out += ` [voice ${voice}] `;
			last = voice;
		}
		out += text;
	}
	return out.replace(/\s+/g, " ").trim();
}

export class Listener {
	private readonly input: Input | undefined;
	private readonly hearer: Hearer;
	/** Hears the next 0.1 s of the person's audio. */
	readonly hear: (pcm: Int16Array) => void;
	private closing = false;

	private constructor(
		input: Input | undefined,
		hearer: Hearer,
		hear: (pcm: Int16Array) => void,
	) {
		this.input = input;
		this.hearer = hearer;
		this.hear = hear;
	}

	/** Opens the tier's hearing, and then the person's audio. */
	static async open(
		listen: Listen,
		hearing: Hearing,
		{ input, floor }: Surroundings,
	): Promise<Listener> {
		let listener: Listener | null = null;
		/** Whether a partial of the segment in progress was loud. */
		let speaking = false;
		/** How loud each chunk heard is, in dBFS, against the floor in force as
		 * it was heard, over the last `KEPT` seconds. */
		const levels: Level[] = [];
		/** Seconds of audio heard since the listener opened. */
		let clock = 0;
		/** Where the segment in progress started, in seconds. */
		let from = 0;
		/** Whether some of the speech in `spans` got louder than the floor. */
		const loud = (spans: [number, number][]): boolean =>
			levels.some(
				(level) =>
					above(level) >= 0 &&
					spans.some(([a, b]) => level.to > a && level.from < b),
			);
		/** Whether the speaker played during some of `spans`. */
		const sounding = (spans: [number, number][]): boolean =>
			levels.some(
				(level) =>
					level.floor !== Number.NEGATIVE_INFINITY &&
					spans.some(([a, b]) => level.to > a && level.from < b),
			);
		/** Where the words were said, or the whole segment so far for words
		 * that are not timed. */
		const spans = (words: Said[]): [number, number][] => {
			const timed = words.filter(
				(w) => /\w/.test(w.text) && w.start !== undefined,
			);
			if (timed.length === 0) return [[from, clock]];
			return timed.map((w) => [
				(w.start ?? 0) - AROUND,
				(w.end ?? clock) + AROUND,
			]);
		};
		const fail = (error: Error) => {
			if (listener === null || listener.closing) return;
			listener.close();
			hearing.failed(error);
		};
		const hearer = await listen({
			voiced: (voiced) => {
				if (!voiced || loud([[clock - ONSET, clock]])) hearing.voiced(voiced);
			},
			voice: (number) => hearing.voice(number),
			partial: (words) => {
				const heard = text(words);
				if (!/\w/.test(heard)) return;
				if (!speaking && !loud(spans(words))) return;
				if (!speaking) hearing.speaking();
				speaking = true;
				hearing.partial(heard);
			},
			segment: (words) => {
				const said = spans(words);
				const isLoud = speaking || loud(said);
				if (!isLoud && /\w/.test(text(words)))
					hearing.trace("quiet", { text: text(words) });
				speaking = false;
				from = clock;
				hearing.segment({ words, loud: isLoud, sounding: sounding(said) });
			},
			failed: fail,
			trace: (event, data) => hearing.trace(event, data),
		});
		const take = (pcm: Int16Array) => {
			hearing.audio(pcm);
			clock += pcm.length / LISTEN_RATE;
			const rms = root(pcm);
			levels.push({
				from: clock - pcm.length / LISTEN_RATE,
				to: clock,
				loudness: 20 * Math.log10(rms),
				floor: floor(),
			});
			while ((levels[0]?.to ?? clock) < clock - KEPT) levels.shift();
			hearing.level(Math.min(1, rms * 8));
			hearer.hear(pcm);
		};
		try {
			await input?.open((error) => fail(error));
		} catch (error) {
			hearer.close();
			throw error;
		}
		listener = new Listener(input, hearer, take);
		return listener;
	}

	/** Ends the segment in progress now, rather than once the tier hears it
	 * end; whether its end is still to come. */
	finish(): boolean {
		return this.hearer.finish();
	}

	close(): void {
		this.closing = true;
		this.input?.close();
		this.hearer.close();
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
