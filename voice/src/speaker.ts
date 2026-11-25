// The speaker: reads the agents' messages aloud as the host gives them, and
// knows how much of each was heard. It gives away the speech it plays, for
// its voice to be known.
import { Player } from "./player.ts";
import { speech } from "./speech.ts";
import { type Piece, SPEECH_RATE, type Synthesizer } from "./tier.ts";

/** A message to read: `id` is the host's, `voice` which of the tier's
 * voices reads it, 0 the one the person chose, each further one apart from
 * those before. A message may still grow, as its writer writes it: given
 * again by its id, with more text, until it is `whole`. */
export type Message = {
	id: string;
	text: string;
	voice?: number;
	/** Whether the text is all there is, as it is unless it says otherwise. */
	whole?: boolean;
};

/** What was heard of message `id`, to within a word, and whether all of it
 * was; for one not heard to its end, why: someone cut in, or the person
 * skipped it, and what of it was not heard, as far as it was written. */
export type Heard = {
	id: string;
	text: string;
	whole: boolean;
	why?: "cut" | "skipped";
	unheard?: string;
};

/** A message being read: its characters with when each starts, in seconds
 * into it. `line` is the player's, new for every reading, so that a message
 * read again starts from nothing. */
type Reading = {
	id: string;
	line: number;
	voice: number;
	/** The message's text so far, and how much of it was given to speak. */
	text: string;
	given: number;
	whole: boolean;
	chars: { char: string; at: number }[];
	/** How many characters it is read as, of what was given so far. */
	length: number;
	/** Lines given to the tier and not yet spoken. */
	saying: number;
	/** Where its audio so far ends, in seconds. */
	start: number;
	done: boolean;
	/** When its first speech came, by `performance.now()`. */
	came: number | null;
};

/** Where a message still growing may be cut to speak what is before: after
 * its last paragraph, else its last sentence, outside a code block. */
function ready(text: string): number {
	let cut = 0;
	for (const match of text.matchAll(/\n\s*\n|[.!?;:](?=\s)/g)) {
		const end = match.index + match[0].length;
		if ((text.slice(0, end).match(/```/g)?.length ?? 0) % 2 === 0) cut = end;
	}
	return cut;
}

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
	/** Messages dropped, whose text still to come is ignored, by id. */
	private readonly gone = new Set<string>();
	/** Paused by the person, which the floor's turns leave as it is. */
	private held = false;
	/** Paused while someone has the floor. */
	private yielded = false;
	/** The last line given before someone took the floor: what a cut drops. */
	private cutoff = 0;
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

	/** Reads a message, after those queued, or what it grew by since it was
	 * last given. */
	speak(message: Message): void {
		if (this.gone.has(message.id)) return;
		const reading = this.readings.find((r) => r.id === message.id);
		if (reading === undefined) {
			this.read(message);
			return;
		}
		if (reading.whole || !message.text.startsWith(reading.text)) return;
		reading.text = message.text;
		reading.whole = message.whole ?? true;
		this.pump();
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

	/** Why the message being read may not sound: paused by the person, or
	 * while someone has the floor; how many seconds ago its first speech came,
	 * if it did, and the seconds of its speech made so far, of which `queued`
	 * are still to render. */
	why(): {
		held: boolean;
		yielded: boolean;
		paused: boolean;
		came: number | null;
		made: number;
		queued: number;
	} {
		const reading = this.readings[0];
		const came = reading?.came ?? null;
		return {
			held: this.held,
			yielded: this.yielded,
			...this.player.held,
			came: came === null ? null : (performance.now() - came) / 1000,
			made: reading?.chars.at(-1)?.at ?? 0,
		};
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

	/** Reads on quieter while someone may be starting to talk, or at full
	 * volume again. */
	duck(ducked: boolean): void {
		this.player.duck(ducked);
	}

	/** Pauses while someone has the floor: what is given from now on is held
	 * for after their turn, and a cut drops only what was given before. */
	pause(): void {
		if (!this.yielded) this.cutoff = this.lines;
		this.yielded = true;
		this.player.pause();
	}

	/** Reads on once the floor is given back, unless the person holds it. */
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
		for (const { id } of this.readings) this.drop(id, "skipped");
		this.gone.delete(message.id);
		this.read(message);
	}

	/** Drops the message being read, and plays on with the next. */
	skip(): void {
		const first = this.readings[0];
		if (first !== undefined) this.drop(first.id, "skipped");
	}

	/**
	 * Stops speaking, as someone cut in: drops every message given before
	 * they took the floor and not yet heard to its end, and reads on with
	 * those given since, held until now. Tells what was heard of each.
	 */
	interrupt(): Heard[] {
		const cutoff = this.yielded ? this.cutoff : this.lines;
		const cut = this.readings.filter((r) => r.line <= cutoff);
		const heard = cut.map((reading) => this.cut(reading, "cut"));
		// Let go of first, so that stopping them settles none as read to its end.
		this.readings = this.readings.filter((r) => r.line > cutoff);
		for (const { line } of cut) this.player.stop(line);
		for (const each of heard) this.done(each);
		this.resume();
		this.changed(this.reading);
		this.pump();
		return heard;
	}

	close(): void {
		for (const { line } of this.readings) this.dropped.add(line);
		this.readings = [];
		this.player.stop();
		this.speech?.close();
	}

	private read(message: Message): void {
		if (!this.speech) return;
		const reading: Reading = {
			id: message.id,
			line: ++this.lines,
			voice: message.voice ?? 0,
			text: message.text,
			given: 0,
			whole: message.whole ?? true,
			chars: [],
			length: 0,
			saying: 0,
			start: 0,
			done: false,
			came: null,
		};
		this.readings.push(reading);
		if (this.readings.length === 1) this.changed(message.id);
		this.pump();
	}

	/** Gives the tier what is ready to speak, message after message: one
	 * still growing holds back those after it, so that the lines play in
	 * order. */
	private pump(): void {
		for (const reading of this.readings) {
			this.give(reading);
			if (!reading.whole) return;
		}
	}

	/** Gives the tier what is ready of a message, each paragraph a line of
	 * its own, timed on from the one before. */
	private give(reading: Reading): void {
		const synthesizer = this.speech;
		if (!synthesizer || reading.done) return;
		const end = reading.whole
			? reading.text.length
			: Math.max(reading.given, ready(reading.text));
		const paragraphs = speech(reading.text.slice(reading.given, end));
		reading.given = end;
		const { line } = reading;
		for (const paragraph of paragraphs) {
			reading.length += paragraph.length + (reading.length > 0 ? 1 : 0);
			reading.saying += 1;
			let from: number | undefined;
			/** Speech not given away yet. */
			let unsent: Float32Array[] = [];
			let length = 0;
			const away = (least: number) => {
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
			synthesizer
				.say(
					paragraph,
					(piece: Piece) => {
						if (this.dropped.has(line)) return false;
						if (from === undefined) {
							from = reading.start;
							// Paragraphs are heard apart, so their texts join with a space.
							if (
								reading.chars.length > 0 &&
								reading.chars.at(-1)?.char !== " "
							)
								reading.chars.push({ char: " ", at: from });
						}
						for (const { char, at } of piece.chars)
							reading.chars.push({ char, at: from + at });
						reading.came ??= performance.now();
						this.player.play(line, reading.start, piece.samples);
						reading.start += piece.samples.length / SPEECH_RATE;
						unsent.push(piece.samples);
						length += piece.samples.length;
						away(GIVEN.most);
						return true;
					},
					reading.voice,
				)
				.catch((error: Error) => this.failed(error))
				.finally(() => {
					away(GIVEN.least);
					reading.saying -= 1;
					this.finish(reading);
				});
		}
		this.finish(reading);
	}

	/** Marks a message done once it is whole and all of it was spoken. */
	private finish(reading: Reading): void {
		if (reading.done || !reading.whole || reading.saying > 0) return;
		if (reading.given < reading.text.length) return;
		reading.done = true;
		this.settle();
	}

	/** What was heard of a message dropped, and the rest as far as written. */
	private cut(reading: Reading, why: "cut" | "skipped"): Heard {
		this.dropped.add(reading.line);
		this.gone.add(reading.id);
		let text = this.heard(reading);
		const { rest, half } = unheard(reading.text, text);
		let left = rest;
		// A word cut in two counts as not heard.
		if (half) {
			const part = text.match(/[\p{L}\p{N}'’-]+$/u)?.[0] ?? "";
			text = text.slice(0, text.length - part.length).trimEnd();
			left = part + rest;
		}
		return { id: reading.id, text, whole: false, why, unheard: left };
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

	private drop(id: string, why: "cut" | "skipped"): void {
		const dropped = this.readings.filter((r) => r.id === id);
		// Let go of first, so that stopping them settles none as read to its end.
		this.readings = this.readings.filter((reading) => reading.id !== id);
		for (const reading of dropped) {
			const heard = this.cut(reading, why);
			this.player.stop(reading.line);
			this.done(heard);
		}
		this.changed(this.reading);
		this.pump();
	}
}

/** What of a message's text was not heard, given what was, as it is read
 * aloud: the heard words matched in order, the rest of the spoken text, and
 * whether the two meet inside a word. */
function unheard(text: string, heard: string): { rest: string; half: boolean } {
	const spoken = speech(text).join(" ");
	const words = heard.split(/\s+/).filter(Boolean);
	let at = 0;
	for (const word of words) {
		const found = spoken.indexOf(word, at);
		if (found < 0) break;
		at = found + word.length;
	}
	const letter = /[\p{L}\p{N}]/u;
	return {
		rest: spoken.slice(at).trim(),
		half:
			at > 0 &&
			letter.test(spoken[at - 1] ?? "") &&
			letter.test(spoken[at] ?? ""),
	};
}
