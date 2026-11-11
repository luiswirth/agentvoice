// What hears and what speaks: the tier, which the host plugs in, such as
// ElevenLabs or an engine on the agent's machine.

/** The rate of the audio hearing gets, and of the speech that comes back. */
export const LISTEN_RATE = 16_000;
export const SPEECH_RATE = 24_000;

/** A word as hearing times it, in seconds of the stream it was given, heard
 * or skipped, or the spacing between words. */
export type Word = { text: string; start: number; end: number };

/** What a transcriber tells as it hears. */
export type Transcript = {
	/** What is heard so far of the segment in progress, each replacing the last. */
	partial(text: string): void;
	/** A segment settled: one committed, or one hearing committed on its own,
	 * with its words timed. */
	committed(text: string, automatic: boolean, words: Word[]): void;
	/** The session ended, with why if it failed. */
	closed(error?: Error): void;
};

/** A session of hearing over a stream, of which it hears what `hear` gives
 * it and skips the rest; its segments end where `commit` settles them. */
export interface Transcriber {
	/** Samples sent in all. */
	readonly sent: number;
	/** The stream's next 16-bit PCM at `LISTEN_RATE`, to transcribe. */
	hear(pcm: Int16Array): void;
	/** The stream's next `samples`, not to transcribe. */
	skip(samples: number): void;
	/** The person started speaking at `at`, in seconds of the stream: a
	 * stretch of speech starts. */
	spoke(at: number): void;
	/** The person paused at `at`: the stretch in progress ended, and may be
	 * transcribed already. */
	paused(at: number): void;
	/** Settles the segment in progress, if it holds enough audio to; whether it did. */
	commit(): boolean;
	close(): void;
}

/** A word as a tier hears it, or the spacing between words, with the
 * number of its voice, null where the voice is not known, and its times in
 * seconds since listening opened, where the tier knows them. */
export type Said = {
	text: string;
	voice: number | null;
	start?: number | undefined;
	end?: number | undefined;
};

/** What a tier tells as it hears, the one interface of both tiers: segments
 * of words, each tagged with its voice, and each segment's end. When a
 * segment ends is the tier's to tell; whether its end ends the person's
 * turn is the core's. */
export type Perception = {
	/** Speech starts or stops, for a tier that hears it apart from words: a
	 * sound that may still turn out to be no words. */
	voiced(voiced: boolean): void;
	/** The voice heard now, while speech goes on, null for one without a number. */
	voice(number: number | null): void;
	/** The words heard so far of the segment in progress, each replacing the last. */
	partial(words: Said[]): void;
	/** The segment in progress ended, with its words, none if it held none. */
	segment(words: Said[]): void;
	/** Hearing stopped on its own, with why. */
	failed(error: Error): void;
	/** What the tier decided, for the trace. */
	trace(event: string, data: Record<string, unknown>): void;
};

/** A tier's hearing of the person's audio, from listening's start. */
export interface Hearer {
	/** The next 0.1 s of 16-bit PCM at `LISTEN_RATE`. */
	hear(pcm: Int16Array): void;
	/** Ends the segment in progress now, as the person ends their turn by
	 * hand; whether its end is still to come. */
	finish(): boolean;
	close(): void;
}

/** Opens a tier's hearing, which tells `perception` what it hears. */
export type Listen = (perception: Perception) => Promise<Hearer>;

/** A stretch of a line's audio, and the characters spoken in it, each with
 * its start in seconds into the line. */
export type Piece = {
	samples: Float32Array;
	chars: { char: string; at: number }[];
};

/** Speaks lines one after the other. */
export interface Synthesizer {
	/** Speaks a line, handing its audio to `piece` as it comes, after the
	 * lines before; `piece` returns whether the line is still wanted, and the
	 * rest of one that is not may go unmade. `voice` is which of the tier's
	 * voices speaks it: 0 the one the person chose, each further one apart
	 * from those before. */
	say(
		line: string,
		piece: (piece: Piece) => boolean,
		voice?: number,
	): Promise<void>;
	close(): void;
}

/** Opens a session of hearing, which tells `heard` what it hears. */
export type Transcribe = (heard: Transcript) => Promise<Transcriber>;

/** Makes what speaks, for one speaker, which closes it once done. */
export type Synthesize = () => Synthesizer;
