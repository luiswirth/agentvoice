// The listener: what the person says, as text, from the microphone through
// Scribe. A segment ends after a pause Scribe hears; whether a segment ends
// the person's turn is for whoever uses the listener to decide. A segment
// counts only once it is loud enough, so that the speaker's echo, which the
// browser's echo cancellation never removes entirely, is not taken for the
// person.
import { Microphone } from "./audio.ts";
import { Scribe } from "./elevenlabs.ts";

export type Hearing = {
	/** The person started saying something, which may still turn out to be no words. */
	speaking(): void;
	/** What was heard so far of the segment in progress. */
	partial(text: string): void;
	/** A segment ended, empty if it held no words or never counted. */
	segment(text: string): void;
	/** How loud the microphone is, from 0 to 1, every 0.1 s. */
	level(level: number): void;
	/** The listener stopped on its own. */
	failed(error: Error): void;
};

/** The pause, in seconds, after which Scribe ends a segment. */
const PAUSE = 1.5;

export class Listener {
	private readonly microphone: Microphone;
	private readonly scribe: Scribe;
	private closing = false;

	private constructor(microphone: Microphone, scribe: Scribe) {
		this.microphone = microphone;
		this.scribe = scribe;
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
		const fail = (error: Error) => {
			if (listener === null || listener.closing) return;
			listener.close();
			hearing.failed(error);
		};
		const scribe = await Scribe.open(
			key,
			{
				partial: (text) => {
					if (!/\w/.test(text)) return;
					if (!speaking && loudest < floor()) return;
					if (!speaking) hearing.speaking();
					speaking = true;
					hearing.partial(text);
				},
				committed: (text) => {
					const counts = speaking || loudest >= floor();
					speaking = false;
					loudest = Number.NEGATIVE_INFINITY;
					scribe.settled();
					hearing.segment(counts ? text.trim() : "");
				},
				closed: (error) => {
					if (error) fail(error);
				},
			},
			PAUSE,
		);
		let microphone: Microphone;
		try {
			microphone = await Microphone.open(
				(pcm) => {
					scribe.hear(pcm);
					const rms = root(pcm);
					loudest = Math.max(loudest, 20 * Math.log10(rms));
					hearing.level(Math.min(1, rms * 8));
				},
				() => fail(new Error("The microphone was cut off.")),
			);
		} catch (error) {
			scribe.close();
			throw error;
		}
		listener = new Listener(microphone, scribe);
		return listener;
	}

	/** Ends the segment in progress now, rather than after the pause. */
	finish(): boolean {
		return this.scribe.commit();
	}

	close(): void {
		this.closing = true;
		this.microphone.close();
		this.scribe.close();
	}
}

/** The root mean square of a chunk, from 0 to 1. */
function root(pcm: Int16Array): number {
	let sum = 0;
	for (const sample of pcm) sum += (sample / 32768) ** 2;
	return Math.sqrt(sum / pcm.length);
}
