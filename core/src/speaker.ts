// The speaker: reads the agents' messages aloud as the host gives them, and
// knows how much of each was heard. It gives away the speech it plays, for
// its voice to be known.
import { Player } from "./player.ts";
import { speech } from "./speech.ts";
import { type Piece, SPEECH_RATE, type Synthesizer } from "./tier.ts";

/** A message to read: `id` is the host's, `voice` which of the tier's
 * voices reads it, 0 the one the person chose, each further one apart from
 * those before. */
export type Message = { id: string; text: string; voice?: number };

/** What was heard of message `id`, to within a word, and whether all of it was. */
export type Heard = { id: string; text: string; whole: boolean };

/** A message being read: its characters with when each starts, in seconds
 * into it. `line` is the player's, new for every reading, so that a message
 * read again starts from nothing. */
type Reading = {
	id: string;
	line: number;
	chars: { char: string; at: number }[];
	/** How many characters the whole message is read as. */
	length: number;
	done: boolean;
};

/** How much speech, in seconds, the speaker gives away at once, and the
 * least it gives away of a message's end: enough for its voice to show. */
const GIVEN = { most: 4, least: 2 };

export class Speaker {
	/** What speaks, while the tier can. */
	private speech: Synthesizer | null = null;
	readonly player = new Player();
	/** The messages queued or playing, oldest first. */
	private readings: Reading[] = [];
	private lines = 0;
	/** Lines dropped, whose speech still to come is ignored. */
	private readonly dropped = new Set<number>();
	/** Paused by the person, which the floor's turns leave as it is. */
	private held = false;
	/** Paused while the person has the floor. */
	private yielded = false;
	/** Called as the message being read changes, with none once none is. */
	changed: (id: string | null) => void = () => {};
	/** Called with speech it is to play, at `SPEECH_RATE`, a few seconds at
	 * a time. */
	played: (samples: Float32Array) => void = () => {};
	/** Called once it is done with a message: read to its end, or dropped. */
	done: (heard: Heard) => void = () => {};
	failed: (error: Error) => void = () => {};

	constructor() {
		this.player.changed = () => this.settle();
	}

	/** Whether it has something to speak with. */
	get ready(): boolean {
		return this.speech !== null;
	}

	/** Speaks with `speech` from now on, or with nothing while the tier can't
	 * speak, when the messages given go unread. */
	use(speech: Synthesizer | null): void {
		if (speech === this.speech) return;
		this.speech?.close();
		this.speech = speech;
	}

	/** Reads a message, after those queued. */
	speak(message: Message): void {
		this.read(message);
	}

	/** The message being read, if one is: the one playing, or else the next to. */
	get reading(): string | null {
		return this.readings[0]?.id ?? null;
	}

	/** Whether the speaker is sounding now. */
	get playing(): boolean {
		return this.player.playing;
	}

	/** How much of the message being read was heard, from 0 to 1, by its
	 * characters: the length of its speech is only known once synthesized. */
	progress(): number {
		const reading = this.readings[0];
		if (reading === undefined || reading.length === 0) return 0;
		const played = this.player.progress(reading.line);
		const unplayed = reading.chars.findIndex(({ at }) => at >= played);
		const heard = unplayed < 0 ? reading.chars.length : unplayed;
		return Math.min(heard / reading.length, 1);
	}

	/** How loud the speaker sounds now, from 0 to 1. */
	level(): number {
		return this.player.level();
	}

	/** Lets go of the messages played to their end. */
	private settle(): void {
		const before = this.reading;
		const playing = this.player.head;
		this.readings = this.readings.filter((reading) => {
			const kept = playing === null ? !reading.done : reading.line >= playing;
			if (!kept)
				this.done({ id: reading.id, text: this.heard(reading), whole: true });
			return kept;
		});
		if (this.reading !== before) this.changed(this.reading);
	}

	/** Reads on quieter while the person may be starting to talk, or at full
	 * volume again. */
	duck(ducked: boolean): void {
		this.player.duck(ducked);
	}

	/** Pauses while the person has the floor. */
	pause(): void {
		this.yielded = true;
		this.player.pause();
	}

	/** Reads on once the person gave the floor back, unless they hold it. */
	resume(): void {
		this.yielded = false;
		this.player.duck(false);
		if (!this.held) this.player.resume();
	}

	/** Pauses or resumes at the person's word. */
	hold(held: boolean): void {
		this.held = held;
		if (held) this.player.pause();
		else if (!this.yielded) this.player.resume();
	}

	/** Reads a message again from its start, before anything queued. */
	replay(message: Message): void {
		if (!this.speech) return;
		for (const { id } of this.readings) this.drop(id);
		this.read(message);
	}

	/** Drops the message being read, and plays on with the next. */
	skip(): void {
		const first = this.readings[0];
		if (first !== undefined) this.drop(first.id);
	}

	/**
	 * Drops every message not yet heard to its end, as the person cuts in,
	 * since each was written before what cut it off: what was heard of each,
	 * empty for one still queued.
	 */
	interrupt(): Heard[] {
		const heard = this.readings.map((reading) => ({
			id: reading.id,
			text: this.heard(reading),
			whole: false,
		}));
		for (const { line } of this.readings) {
			this.dropped.add(line);
			this.player.stop(line);
		}
		this.readings = [];
		for (const each of heard) this.done(each);
		this.resume();
		this.changed(this.reading);
		return heard;
	}

	close(): void {
		for (const { line } of this.readings) this.dropped.add(line);
		this.readings = [];
		this.player.stop();
		this.speech?.close();
	}

	private read(message: Message): void {
		const synthesizer = this.speech;
		if (!synthesizer) return;
		const line = ++this.lines;
		const paragraphs = speech(message.text);
		const reading: Reading = {
			id: message.id,
			line,
			chars: [],
			length: paragraphs.join(" ").length,
			done: false,
		};
		this.readings.push(reading);
		if (this.readings.length === 1) this.changed(message.id);
		// Each paragraph is a line of its own, timed on from the one before:
		// `start` is where the message's audio so far ends, `from` where the
		// paragraph's began, which its characters are timed from.
		let start = 0;
		/** Speech not given away yet. */
		let unsent: Float32Array[] = [];
		let length = 0;
		const give = (least: number) => {
			if (length < least * SPEECH_RATE) return;
			const samples = new Float32Array(length);
			let at = 0;
			for (const piece of unsent) {
				samples.set(piece, at);
				at += piece.length;
			}
			unsent = [];
			length = 0;
			this.played(samples);
		};
		const lines = paragraphs.map((paragraph, i) => {
			let from: number | undefined;
			return synthesizer.say(
				paragraph,
				(piece: Piece) => {
					if (this.dropped.has(line)) return false;
					if (from === undefined) {
						from = start;
						// Paragraphs are heard apart, so their texts join with a space.
						if (i > 0 && reading.chars.at(-1)?.char !== " ")
							reading.chars.push({ char: " ", at: start });
					}
					for (const { char, at } of piece.chars)
						reading.chars.push({ char, at: from + at });
					this.player.play(line, start, piece.samples);
					start += piece.samples.length / SPEECH_RATE;
					unsent.push(piece.samples);
					length += piece.samples.length;
					give(GIVEN.most);
					return true;
				},
				message.voice ?? 0,
			);
		});
		Promise.all(lines)
			.catch((error: Error) => this.failed(error))
			.finally(() => {
				give(GIVEN.least);
				reading.done = true;
				this.settle();
			});
	}

	/** The text of a message heard so far, to within a word. */
	private heard(reading: Reading): string {
		const played = this.player.progress(reading.line);
		// Always a start of the message: ElevenLabs times each alignment from
		// the start of the audio it comes with, while the speech it times can
		// run on into later audio, so a later piece's first characters can be
		// timed before an earlier piece's last.
		const unplayed = reading.chars.findIndex(({ at }) => at >= played);
		return reading.chars
			.slice(0, unplayed < 0 ? undefined : unplayed)
			.map(({ char }) => char)
			.join("")
			.trim();
	}

	private drop(id: string): void {
		for (const reading of this.readings.filter((r) => r.id === id)) {
			this.dropped.add(reading.line);
			this.player.stop(reading.line);
			this.done({ id, text: this.heard(reading), whole: false });
		}
		this.readings = this.readings.filter((reading) => reading.id !== id);
		this.changed(this.reading);
	}
}
