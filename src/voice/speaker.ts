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

/** A message being read: its characters with when each starts, in seconds
 * into it. `line` is the player's, new for every reading, so that a message
 * read again starts from nothing. */
type Reading = {
	n: number;
	line: number;
	chars: { char: string; at: number }[];
	done: boolean;
};

export class Speaker {
	private readonly speech: Speech;
	private readonly player = new Player();
	private readonly session: Session;
	private readonly name: string;
	private readonly unsubscribe: () => void;
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
	changed: (n: number | null) => void = () => {};
	failed: (error: Error) => void = () => {};

	/** Reads the messages not from `name`: those since `name` last said
	 * anything, which are still to be answered, and every one after, except
	 * those this tab already read, heard or dropped before a reload. */
	constructor(session: Session, name: string, key: string, voice?: string) {
		this.session = session;
		this.name = name;
		this.speech = new Speech(key, voice);
		this.player.changed = () => this.settle();
		const since = Math.max(
			session.log.findLast((entry) => entry.from === name && spoken(entry))
				?.n ?? 0,
			Number(sessionStorage.getItem(this.key) ?? 0),
		);
		for (const entry of session.log)
			if (entry.n > since && entry.from !== name && spoken(entry))
				this.read(entry);
		const after = session.log.at(-1)?.n ?? 0;
		this.unsubscribe = session.subscribe({
			entry: (entry) => {
				if (entry.n > after && entry.from !== name && spoken(entry))
					this.read(entry);
			},
		});
	}

	/** Where the tab keeps the last message it is done with, so that a reload
	 * reads none of them again. */
	private readonly key = `voice-read ${location.href}`;

	/** Done with every message up to `n`: read to its end, or dropped. */
	private done(n: number): void {
		if (n > Number(sessionStorage.getItem(this.key) ?? 0))
			sessionStorage.setItem(this.key, String(n));
	}

	/** The message being read, if one is: the one playing, or else the next to. */
	get reading(): number | null {
		return this.readings[0]?.n ?? null;
	}

	/** Whether the speaker is sounding now. */
	get playing(): boolean {
		return this.player.playing;
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
			if (!kept) this.done(reading.n);
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

	/** The last message the others sent, to read again. */
	get last(): (Entry & { text: string }) | undefined {
		return this.session.log.findLast(
			(entry): entry is Entry & { text: string } =>
				entry.from !== this.name && spoken(entry),
		);
	}

	/** Reads the last message again from its start, before anything queued. */
	replay(): void {
		const last = this.last;
		if (last === undefined) return;
		for (const { n } of this.readings) this.drop(n);
		this.read(last);
	}

	/** Drops the message being read, and plays on with the next. */
	skip(): void {
		const first = this.readings[0];
		if (first !== undefined) this.drop(first.n);
	}

	/**
	 * Drops every message not yet heard to its end, as the person cuts in,
	 * since each was written before what cut it off: what was heard of each,
	 * empty for one still queued, which goes to the log before what cut it off.
	 */
	interrupt(): Heard[] {
		const heard = this.readings.map((reading) => ({
			n: reading.n,
			text: this.heard(reading),
		}));
		for (const { n, line } of this.readings) {
			this.dropped.add(line);
			this.player.stop(line);
			this.done(n);
		}
		this.readings = [];
		this.resume();
		this.changed(this.reading);
		return heard;
	}

	close(): void {
		this.unsubscribe();
		for (const { line } of this.readings) this.dropped.add(line);
		this.readings = [];
		this.player.stop();
		this.speech.close();
	}

	private read(entry: Entry & { text: string }): void {
		const line = ++this.lines;
		const reading: Reading = { n: entry.n, line, chars: [], done: false };
		this.readings.push(reading);
		if (this.readings.length === 1) this.changed(entry.n);
		// Each paragraph is a line of its own, timed on from the one before.
		let start = 0;
		const lines = speech(entry.text).map((paragraph, i) =>
			this.speech.say(paragraph, (piece: Piece) => {
				if (this.dropped.has(line)) return;
				// Paragraphs are heard apart, so their texts join with a space.
				if (i > 0 && reading.chars.at(-1)?.char !== " ")
					reading.chars.push({ char: " ", at: start });
				for (const { char, at } of piece.chars)
					reading.chars.push({ char, at: start + at });
				this.player.play(line, start, piece.samples);
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

	private drop(n: number): void {
		this.done(n);
		for (const reading of this.readings.filter((r) => r.n === n)) {
			this.dropped.add(reading.line);
			this.player.stop(reading.line);
		}
		this.readings = this.readings.filter((reading) => reading.n !== n);
		this.changed(this.reading);
	}
}
