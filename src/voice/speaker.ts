// The speaker: reads the others' chat messages aloud as they arrive, and
// knows how much of each was heard.
import { Player } from "./audio.ts";
import { type Piece, SPEECH_RATE, type Synthesizer } from "./engines.ts";
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

/** How much of what the speaker played the listener's words are matched
 * against, in seconds back from where it is: what its echo may still be. */
const ECHO = 4;

/** How many of the words heard must be, in order, words the speaker just
 * played for them to be its echo: Scribe mishears some of them. */
const ECHOED = 0.7;

/** How long before the speaker started a message may have arrived and
 * still be read, in seconds: one that came during a reload. */
const RECENT = 10;

export class Speaker {
	/** What speaks, while the tier can. */
	private speech: Synthesizer | null = null;
	/** The last entry before the speaker started. */
	private readonly started: number;
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
	/** The words the message read last ended on, until when, in the page's
	 * clock, their echo may still be heard. */
	private tail: { words: string[]; until: number } = { words: [], until: 0 };
	/** Called as the message being read changes, with none once none is. */
	changed: (n: number | null) => void = () => {};
	failed: (error: Error) => void = () => {};

	/** Reads the messages not from `name` once it has something to speak
	 * with, as `use` gives it. */
	constructor(session: Session, name: string) {
		this.session = session;
		this.name = name;
		this.player.changed = () => this.settle();
		this.started = session.log.at(-1)?.n ?? 0;
		this.unsubscribe = session.subscribe({
			entry: (entry) => {
				if (entry.n > this.started && this.speech && this.wanted(entry))
					this.read(entry);
			},
		});
	}

	private wanted(entry: Entry): entry is Entry & { text: string } {
		return entry.from !== this.name && spoken(entry);
	}

	/** Whether it has something to speak with. */
	get ready(): boolean {
		return this.speech !== null;
	}

	/**
	 * Speaks with `speech` from now on, or with nothing while the tier can't
	 * speak, when the messages that arrive go unread. Given something, it
	 * reads at once the messages after entry `after`, from which on the tier
	 * could speak, except those this tab already read, heard or dropped; of
	 * those from before it started, only the ones that arrived just before,
	 * as during a reload. None from further back: the person may have heard
	 * or read them, and can have the last read again.
	 */
	use(speech: Synthesizer | null, after = 0): void {
		this.speech?.close();
		this.speech = speech;
		if (!speech) return;
		const since = Number(sessionStorage.getItem(this.key) ?? 0);
		const recent = Date.now() - RECENT * 1000;
		for (const entry of this.session.log)
			if (
				entry.n > Math.max(after, since) &&
				(entry.n > this.started || Date.parse(entry.time) > recent) &&
				this.wanted(entry)
			)
				this.read(entry);
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

	/**
	 * Whether what the listener heard is the speaker's own voice, back through
	 * the microphone: words it played in the last few seconds. The browser's
	 * echo cancellation lets it through at times, as loud as the person.
	 */
	echoes(text: string): boolean {
		const heard = words(text);
		if (heard.length === 0) return false;
		const played = [
			...(this.tail.until > performance.now() ? this.tail.words : []),
			...this.readings.flatMap((reading) => {
				const at = this.player.progress(reading.line);
				// A word's alignment can run a little ahead of its sound.
				return at > 0 ? words(sounded(reading, at - ECHO, at + 0.5)) : [];
			}),
		];
		return common(heard, played) >= ECHOED * heard.length;
	}

	/** Lets go of the messages played to their end. */
	private settle(): void {
		const before = this.reading;
		const playing = this.player.head;
		this.readings = this.readings.filter((reading) => {
			const kept = playing === null ? !reading.done : reading.line >= playing;
			if (!kept) {
				this.done(reading.n);
				const end = reading.chars.at(-1)?.at ?? 0;
				this.tail = {
					words: words(sounded(reading, end - ECHO, end)),
					until: performance.now() + ECHO * 1000,
				};
			}
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
		if (last === undefined || !this.speech) return;
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
		this.speech?.close();
	}

	private read(entry: Entry & { text: string }): void {
		const synthesizer = this.speech;
		if (!synthesizer) return;
		const line = ++this.lines;
		const reading: Reading = { n: entry.n, line, chars: [], done: false };
		this.readings.push(reading);
		if (this.readings.length === 1) this.changed(entry.n);
		// Each paragraph is a line of its own, timed on from the one before:
		// `start` is where the message's audio so far ends, `from` where the
		// paragraph's began, which its characters are timed from.
		let start = 0;
		const lines = speech(entry.text).map((paragraph, i) => {
			let from: number | undefined;
			return synthesizer.say(paragraph, (piece: Piece) => {
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
				return true;
			});
		});
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

/** The text of a reading between two times into it, in seconds. */
function sounded(reading: Reading, from: number, to: number): string {
	return reading.chars
		.filter(({ at }) => at >= from && at <= to)
		.map(({ char }) => char)
		.join("");
}

/** A text's words, in lower case, without punctuation. */
function words(text: string): string[] {
	return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** How many words two texts have in common, in order. */
function common(a: string[], b: string[]): number {
	let row = new Array<number>(b.length + 1).fill(0);
	for (const x of a) {
		const next = [0];
		for (const [j, y] of b.entries())
			next.push(
				x === y ? (row[j] ?? 0) + 1 : Math.max(row[j + 1] ?? 0, next[j] ?? 0),
			);
		row = next;
	}
	return row[b.length] ?? 0;
}
