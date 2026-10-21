// The listener: what the person says, as text, from the microphone through
// Scribe. A segment ends after a pause Scribe hears; whether a segment ends
// the person's turn is for whoever uses the listener to decide.
import { Microphone } from "./audio.ts";
import { Scribe } from "./elevenlabs.ts";

export type Hearing = {
	/** The person started saying something, which may still turn out to be no words. */
	speaking(): void;
	/** What was heard so far of the segment in progress. */
	partial(text: string): void;
	/** A segment ended, empty if it held no words. */
	segment(text: string): void;
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

	/** Call it from a click, since it starts the page's audio. */
	static async open(key: string, hearing: Hearing): Promise<Listener> {
		let listener: Listener | null = null;
		let speaking = false;
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
					if (!speaking) hearing.speaking();
					speaking = true;
					hearing.partial(text);
				},
				committed: (text) => {
					speaking = false;
					scribe.settled();
					hearing.segment(text.trim());
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
				(pcm) => scribe.hear(pcm),
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
