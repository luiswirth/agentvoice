// The speaker: reads the others' chat messages aloud as they arrive, and
// knows how much of each was heard.
import { Player } from "./audio.ts";
import { type Piece, SPEECH_RATE, Speech } from "./elevenlabs.ts";
import {
	type Entry,
	type Heard,
	type Session,
	speech,
	spoken,
} from "./protocol.ts";

/** A message being read: its characters with when each starts, in seconds into it. */
type Reading = {
	n: number;
	chars: { char: string; at: number }[];
	done: boolean;
};

export class Speaker {
	private readonly speech: Speech;
	private readonly player = new Player();
	private readonly unsubscribe: () => void;
	/** The messages queued or playing, oldest first. */
	private readings: Reading[] = [];
	/** Messages dropped, whose speech still to come is ignored. */
	private readonly dropped = new Set<number>();
	/** Called as the message being read changes, with none once none is. */
	changed: (n: number | null) => void = () => {};
	failed: (error: Error) => void = () => {};

	/** Reads what `session` brings from now on that is not from `name`. */
	constructor(session: Session, name: string, key: string, voice?: string) {
		this.speech = new Speech(key, voice);
		this.player.changed = () => this.settle();
		const after = session.log.at(-1)?.n ?? 0;
		this.unsubscribe = session.subscribe({
			entry: (entry) => {
				if (entry.n > after && entry.from !== name && spoken(entry))
					this.read(entry);
			},
		});
	}

	/** The message being read, if one is: the one playing, or else the next to. */
	get reading(): number | null {
		return this.readings[0]?.n ?? null;
	}

	/** Lets go of the messages played to their end. */
	private settle(): void {
		const before = this.reading;
		const playing = this.player.head;
		this.readings = this.readings.filter((reading) =>
			playing === null ? !reading.done : reading.n >= playing,
		);
		if (this.reading !== before) this.changed(this.reading);
	}

	pause(): void {
		this.player.pause();
	}

	resume(): void {
		this.player.resume();
	}

	/** Drops the message being read, and plays on with the next. */
	skip(): void {
		const first = this.readings[0];
		if (first !== undefined) this.drop(first.n);
	}

	/**
	 * Drops everything not yet played, as the person cuts in: what was heard
	 * of each message cut off, which goes to the log before what cut it off.
	 */
	interrupt(): Heard[] {
		const heard = this.readings.map((reading) => ({
			n: reading.n,
			text: this.heard(reading),
		}));
		for (const { n } of this.readings) this.dropped.add(n);
		this.readings = [];
		this.player.stop();
		this.player.resume();
		this.changed(null);
		return heard;
	}

	close(): void {
		this.unsubscribe();
		this.interrupt();
		this.speech.close();
	}

	private read(entry: Entry & { text: string }): void {
		const reading: Reading = { n: entry.n, chars: [], done: false };
		this.readings.push(reading);
		if (this.readings.length === 1) this.changed(entry.n);
		// Each paragraph is a line of its own, timed on from the one before.
		let start = 0;
		const lines = speech(entry.text).map((paragraph) =>
			this.speech.say(paragraph, (piece: Piece) => {
				if (this.dropped.has(entry.n)) return;
				for (const { char, at } of piece.chars)
					reading.chars.push({ char, at: start + at });
				this.player.play(entry.n, start, piece.samples);
				start += piece.samples.length / SPEECH_RATE;
			}),
		);
		Promise.all(lines)
			.catch((error: Error) => this.failed(error))
			.finally(() => {
				reading.done = true;
				this.settle();
			});
	}

	/** The text of a message heard so far, to within a word. */
	private heard(reading: Reading): string {
		const played = this.player.progress(reading.n);
		return reading.chars
			.filter(({ at }) => at < played)
			.map(({ char }) => char)
			.join("")
			.trim();
	}

	private drop(n: number): void {
		this.dropped.add(n);
		this.readings = this.readings.filter((reading) => reading.n !== n);
		this.player.stop(n);
		this.changed(this.reading);
	}
}
