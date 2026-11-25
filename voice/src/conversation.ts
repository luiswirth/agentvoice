// A conversation by voice: one ear and one mouth, the listener and the
// speaker, each on or off on its own. Both on is a conversation, the speaker
// alone read aloud, the listener alone hearing.
// Everything heard goes out as it is heard, one segment at a time, tagged by
// voice, but for the speaker's own echo: whether it is meant for the agent is
// the agent's to judge. Only two reflexes act on it here, since they would
// take too long through the agent's mind:
// - Words cut in: the speaker stops, and drops what was not heard of what it
//   was given before. The voice the speaker plays is its own, heard back as
//   echo, which never cuts in. While the speaker plays, words cut in only
//   once their voice is known, and only a few words or a word to stop, so
//   that it reads on over a "mhm"; once any voice is named, only a named one.
// - Someone has the floor: what the speaker is given meanwhile is held until
//   their segment is over.
// What happens is heard as short cues, so that voice seems responsive while
// nothing is said.
// Its edges are the person's audio in, the audio to play out, the agent's
// messages in, and what is heard and spoken out: the host carries them, and
// plugs in the tier, which hears and speaks.
import { type Cue, Cues } from "./cues.ts";
import { type Input, Listener, type Segment, tag, text } from "./listener.ts";
import { Resampler } from "./resampler.ts";
import { type Heard, type Message, Speaker } from "./speaker.ts";
import {
	LISTEN_RATE,
	type Listen,
	type Said,
	type Synthesize,
} from "./tier.ts";

/** Who the voices are, by the number of their tag in the transcript. */
export type Names = Record<string, string>;

/** What the host sets, at the start and whenever it changes. */
export type Settings = {
	/** Whether the person is heard. */
	listener: boolean;
	/** Whether the agents' messages are read aloud. */
	speaker: boolean;
	/** Whether what happens is heard as cues. */
	sounds: boolean;
	/** Who the voices are: once any is named, only a named voice can cut
	 * in. */
	names: Names;
	/** How the tier hears. Listening opens it again for a new one, at once
	 * while nothing is being heard. */
	listen: Listen;
	/** How the tier speaks, null while it can't: the messages given then go
	 * unread. */
	synthesize: Synthesize | null;
};

export type Options = Partial<Settings> &
	Pick<Settings, "listen"> & {
		/** The person's audio, which listening opens and closes. */
		input?: Input;
	};

export type State = Omit<Settings, "listen" | "synthesize"> & {
	/** Listening while it opens. */
	switching: "listener" | null;
	/** What is heard of the segment in progress. */
	hearing: string;
	/** How loud the person's audio is, from 0 to 1. */
	level: number;
	/** The message being read aloud, by its id. */
	reading: string | null;
	/** Whether the person paused reading aloud. */
	held: boolean;
	/** The voice heard now, by its number, null for one without a number,
	 * undefined while none is heard. */
	voice?: number | null | undefined;
	/** Words heard last that didn't count, as the speaker's echo, too quiet,
	 * or a backchannel while it played, for the person to send if they were
	 * theirs. */
	missed: { text: string; why: "echo" | "quiet" | "backchannel" } | null;
};

/** A segment heard: its words tagged by voice, as `[voice 1] ...`, always
 * starting with a tag, `[voice ?]` for a voice without a number, the
 * voices in it, null for one without a number, and whether it only signals
 * listening, a backchannel, or is words that didn't count, which the person
 * sent as theirs. */
export type Utterance = {
	text: string;
	voices: (number | null)[];
	backchannel: boolean;
	missed: boolean;
};

/** The person's listener and speaker, as the agents should know them. */
export type Modes = Pick<Settings, "listener" | "speaker">;

export type Events = {
	state(state: State): void;
	/** A segment heard, for the agent. */
	speech(utterance: Utterance): void;
	/** Done with a message: read to its end, or dropped; for one cut,
	 * `by` is the voice that cut in. */
	heard(heard: Heard & { by?: number | null }): void;
	/** The modes, as they change, and as they come back on as they were. */
	modes(modes: Modes): void;
	/** What failed, to show, or null once it no longer holds. */
	error(error: Error | null): void;
	/** What the core does, as events to look into it by. */
	trace(event: string, data: Record<string, unknown>): void;
	/** The person's audio as listening hears it, 16-bit PCM at `LISTEN_RATE`. */
	audio(pcm: Int16Array): void;
	/** What is to play changed: the host drops what it holds of what `play`
	 * gave it, and gives it back with `unplay`, so that the change is heard
	 * at once. A host that holds nothing needs no handler. */
	flush(): void;
};

/** What happens around the conversation, which the host sees and the core
 * makes heard: the person pressed something; what was heard reached the
 * agent; the agent took it in and works on it; the agent sent a message to
 * read, or anything else; someone joined or left; something failed. */
export type Fact =
	| "press"
	| "sent"
	| "read"
	| "message"
	| "other"
	| "joined"
	| "left"
	| "problem";

/** The pauses between the cues that the agent is still working, in seconds:
 * close at first, when an answer may still come any moment, then sparse,
 * the last repeating. */
const WORKING = [3, 5, 8, 12, 20];

/** How long after the agent read the person's turn, in milliseconds, its
 * cue plays if it hasn't answered by then. */
const READ = 1000;

/** How soon after the speaker finished a message, in seconds, the next one
 * read counts as following it. */
const NEXT = 4;

/** How loud, in dBFS, the person must get to count while the speaker plays:
 * the speaker's echo left over measured -42 to -57, the person's speech -12
 * to -13, and -35 within 0.25 s of its start. */
const ECHO_FLOOR = -35;

/** How many words take the floor while the speaker plays, so that a short
 * answer or a "mhm" doesn't stop it. */
const FLOOR_WORDS = 3;
/** Words that take the floor alone, in the languages voice is used in. */
const STOP = new Set(["stop", "stopp", "wait", "halt", "pause", "warte"]);
/** Words that only signal listening, as transcribed, "mm-hmm" as "mm" and
 * "hmm". An answer such as "yes" or "no" is none: it is meant for the agent. */
const BACKCHANNEL = new Set([
	// English
	"mhm",
	"mm",
	"hmm",
	"hm",
	"uh",
	"huh",
	"ah",
	"aha",
	"oh",
	"yeah",
	"yep",
	"okay",
	"ok",
	"right",
	// German
	"ja",
	"genau",
]);
/** How long words that didn't count show, in seconds. */
const MISSED = 12;
/** How long, in seconds, a message is read with nothing of it heard before
 * the trace tells why: once its speech came, and while none came. */
const SILENT = { came: 3, coming: 10 };

/** The person's audio is heard in chunks of 0.1 s. */
const CHUNK = LISTEN_RATE / 10;

/** The words of a text, lower case, without punctuation. */
function wordsOf(text: string): string[] {
	return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Text heard with a voice's tag at its start, `[voice ?]` where the voice
 * of its first words is not known, so that every segment says whose it is. */
function tagged(text: string): string {
	return text.startsWith("[voice ") ? text : `[voice ?] ${text}`;
}

export class Conversation {
	private readonly input: Input | undefined;
	private listening: Listen;
	private synthesize: Synthesize | null;
	private listener: Listener | null = null;
	private speaker: Speaker | null = null;
	private readonly cues = new Cues();
	/** The person's audio at `LISTEN_RATE`, as 16-bit PCM, filling a chunk. */
	private capture: {
		rate: number;
		resampler: Resampler | null;
		pcm: Int16Array;
		filled: number;
	} | null = null;
	/** Whether listening is off, with the listener still finishing the
	 * segment in progress, whose words still go out. */
	private stopping = false;
	/** Whether the segment in progress has words, whether they took the
	 * floor, and the voice that took it. */
	private words = false;
	private floor = false;
	private by: number | null = null;
	/** What was heard so far of the segment in progress, shown as `hearing`
	 * once it may be the person's. */
	private heard = "";
	/** Whether the voice heard now is known, and whether the speaker played it. */
	private known = false;
	private played = false;
	/** While modes come back on as they were: as the core starts, or as
	 * listening reopens. */
	private restoring = false;
	private readonly handlers: { [K in keyof Events]: Set<Events[K]> } = {
		state: new Set(),
		speech: new Set(),
		heard: new Set(),
		modes: new Set(),
		error: new Set(),
		trace: new Set(),
		audio: new Set(),
		flush: new Set(),
	};
	/** What `play` gave in all, at the rate it was last asked for, less what
	 * the host gave back. */
	private given = 0;
	private rate = 0;
	/** Whether a flush is asked for and not yet answered, and whether what is
	 * to play changed again since it was asked for. */
	private flushing = false;
	private again = false;
	/** The next cue that the agent is still working, while it is. */
	private working: ReturnType<typeof setTimeout> | undefined;
	/** When the cue of sending last played, by `performance.now()`. */
	private sentAt = 0;
	/** The cue that the agent read the person's turn, while it waits. */
	private readCue: ReturnType<typeof setTimeout> | undefined;
	private missedClear: ReturnType<typeof setTimeout> | undefined;
	/** When the speaker last finished a message, by `performance.now()`. */
	private readEnded = Number.NEGATIVE_INFINITY;
	/** When the host last pulled what to play, by `performance.now()`. */
	private pulled = Number.NEGATIVE_INFINITY;
	/** Checks a message being read that isn't heard yet. */
	private silent: ReturnType<typeof setInterval> | undefined;
	state: State;

	/** Starts as `options` set it, without the cues of turning on: listening
	 * opens at once if on, and the speaker reads what it is given from now. */
	constructor(options: Options) {
		this.input = options.input;
		this.listening = options.listen;
		this.synthesize = options.synthesize ?? null;
		this.state = {
			listener: false,
			speaker: false,
			sounds: options.sounds ?? true,
			names: options.names ?? {},
			switching: null,
			hearing: "",
			level: 0,
			reading: null,
			held: false,
			missed: null,
		};
		this.cues.skipped = (cue, late) => this.trace("cue.skipped", { cue, late });
		this.cues.flush = () => this.flush();
		this.restoring = true;
		if (options.speaker) this.setSpeaker(true);
		void (options.listener ? this.listen(true) : Promise.resolve()).finally(
			() => {
				this.restoring = false;
			},
		);
	}

	/** Calls `handler` with each event of its kind, until the returned
	 * function is called. */
	on<K extends keyof Events>(event: K, handler: Events[K]): () => void {
		this.handlers[event].add(handler);
		return () => this.handlers[event].delete(handler);
	}

	private emit<K extends keyof Events>(
		event: K,
		...args: Parameters<Events[K]>
	): void {
		for (const handler of this.handlers[event])
			(handler as (...args: Parameters<Events[K]>) => void)(...args);
	}

	private trace(event: string, data: Record<string, unknown> = {}): void {
		this.emit("trace", event, data);
	}

	/** Changes what the host sets: only what is in `change`. Listening
	 * opens or closes as it says, settled once the returned promise is. */
	async set(change: Partial<Settings>): Promise<void> {
		const { sounds, names } = change;
		if (sounds !== undefined && sounds !== this.state.sounds) {
			this.update({ sounds });
			if (sounds) this.cue("press");
		}
		if (names !== undefined) {
			this.update({ names });
			this.trace("names", names);
		}
		if (change.synthesize !== undefined) {
			this.synthesize = change.synthesize;
			this.speaker?.use(this.synthesize?.() ?? null);
		}
		if (change.speaker !== undefined) this.setSpeaker(change.speaker);
		const opening =
			change.listener !== undefined ? this.listen(change.listener) : undefined;
		if (change.listen !== undefined) {
			this.listening = change.listen;
			await opening;
			await this.reopen();
		}
		await opening;
	}

	/** The person's audio, at any `rate`, as it comes: it is heard while
	 * listening, else let go. */
	hear(pcm: Float32Array, rate: number): void {
		if (this.capture?.rate !== rate)
			this.capture = {
				rate,
				resampler:
					rate === LISTEN_RATE ? null : new Resampler(rate, LISTEN_RATE),
				pcm: new Int16Array(CHUNK),
				filled: 0,
			};
		const capture = this.capture;
		const samples = capture.resampler?.push(pcm) ?? pcm;
		for (const sample of samples) {
			capture.pcm[capture.filled++] = Math.round(
				Math.max(-1, Math.min(1, sample)) * 32767,
			);
			if (capture.filled < CHUNK) continue;
			const chunk = capture.pcm;
			capture.pcm = new Int16Array(CHUNK);
			capture.filled = 0;
			if (this.listener !== null && !this.stopping) this.listener.hear(chunk);
		}
	}

	/** The next `out.length` samples to play, at `rate`, into `out`: the
	 * speech read aloud, with the cues mixed in. The host pulls them as it
	 * plays, without a pause. `played`: how much of all `play` gave it the
	 * host played by now, for one that holds some a while before it plays it;
	 * without it, all of it. What was heard follows what was played. */
	play(out: Float32Array, rate: number, played?: number): void {
		this.pulled = performance.now();
		if (rate !== this.rate) {
			this.given = 0;
			this.rate = rate;
		}
		this.speaker?.player.holds(
			played === undefined ? 0 : Math.max(0, this.given - played),
			rate,
		);
		out.fill(0);
		this.speaker?.player.render(out, rate);
		this.cues.render(out, rate);
		this.given += out.length;
	}

	/** The last `samples` that `play` gave, which the host dropped unplayed
	 * as `flush` asked: they are rendered anew. */
	unplay(samples: number): void {
		const back = Math.min(samples, this.given);
		this.given -= back;
		this.speaker?.player.unrender(back, this.rate);
		this.cues.unrender(back / this.rate);
		this.flushing = false;
		if (this.again) {
			this.again = false;
			this.flush();
		}
	}

	/** Has the host drop what it holds, once it holds anything. */
	private flush(): void {
		if (this.handlers.flush.size === 0 || this.given === 0) return;
		if (this.flushing) {
			this.again = true;
			return;
		}
		this.flushing = true;
		this.emit("flush");
	}

	/** An agent's message, to read aloud after those queued, while the
	 * speaker is on and the tier can speak. */
	speak(message: Message): void {
		this.speaker?.speak(message);
	}

	/** Reads `message` again from its start, before anything queued,
	 * turning the speaker on if it is off. */
	replay(message: Message): void {
		if (!this.state.speaker) this.setSpeaker(true);
		this.hold(false);
		this.trace("replay");
		this.speaker?.replay(message);
	}

	/** What happened around the conversation, to be heard. */
	notice(fact: Fact): void {
		switch (fact) {
			case "sent":
				this.stopWorking();
				return;
			case "read":
				clearTimeout(this.working);
				this.work(0);
				// An agent often reads the person's turn only right before it
				// answers, so the cue waits a second, and plays only if the
				// agent is still working by then.
				clearTimeout(this.readCue);
				this.readCue = setTimeout(
					() => this.ring("read"),
					Math.max(READ, this.sentAt + READ - performance.now()),
				);
				return;
			case "message": {
				this.stopWorking();
				// A message read aloud now is heard as it is read, so a cue would
				// only come before the voice: it sounds only for one that waits,
				// while the person talks or reading aloud is paused, or isn't read.
				const waits =
					this.state.held ||
					this.state.hearing !== "" ||
					this.state.voice !== undefined;
				if (!this.state.speaker || waits) this.ring("message");
				return;
			}
			case "other":
				this.ring("other");
				if (this.working !== undefined) this.work(0);
				return;
			default:
				this.ring(fact);
				return;
		}
	}

	private stopWorking(): void {
		clearTimeout(this.working);
		this.working = undefined;
		clearTimeout(this.readCue);
	}

	/** Plays the cue that the agent is still working after the `step`th pause,
	 * unless something else is heard then, and goes on. Something the agent
	 * does starts the pauses over. */
	private work(step: number): void {
		clearTimeout(this.working);
		const pause = WORKING[Math.min(step, WORKING.length - 1)] ?? 0;
		this.working = setTimeout(() => {
			const busy =
				this.state.reading !== null ||
				this.state.hearing !== "" ||
				this.state.voice !== undefined;
			if (!busy) this.ring("working");
			this.work(step + 1);
		}, pause * 1000);
	}

	/** Plays a cue, if cues are on. */
	private ring(cue: Cue): void {
		if (!this.state.sounds) return;
		this.trace("cue", { cue });
		this.cues.ask(cue);
	}

	/** A cue for the person's own act, which plays only for theirs, not
	 * while modes come back on as they were. */
	private cue(cue: Cue): void {
		if (!this.restoring) this.ring(cue);
	}

	/** The state that shows `error`. */
	private failure(error: Error): void {
		this.ring("problem");
		this.emit("error", error);
	}

	/** How loud the speaker sounds now, from 0 to 1: read it as often as
	 * needed, since it changes too fast for `state`. */
	speakerLevel(): number {
		return this.speaker?.level() ?? 0;
	}

	/** How much of the message being read was heard, from 0 to 1: read it as
	 * often as needed, since it changes too fast for `state`. */
	speakerProgress(): number {
		return this.speaker?.progress() ?? 0;
	}

	private async listen(on: boolean): Promise<void> {
		if (on === this.state.listener || this.state.switching) return;
		if (!on) {
			// Words in progress still go out: the person's audio is heard no
			// more, and the listener closes once they are in.
			if (this.state.hearing && this.listener?.finish()) this.stopping = true;
			else this.closeListener();
			this.update({ listener: false, level: 0 });
			this.cue("unlisten");
			this.modes();
			return;
		}
		if (this.stopping) {
			// Still finishing: it listens on, and the words go out as they would.
			this.stopping = false;
			this.update({ listener: true });
			this.emit("error", null);
			this.cue("listen");
			this.modes();
			return;
		}
		this.update({ switching: "listener" });
		this.emit("error", null);
		this.yieldFloor();
		this.heard = "";
		this.known = false;
		this.played = false;
		// What is heard counts from listening's start.
		this.capture = null;
		try {
			this.listener = await Listener.open(
				this.listening,
				{
					// The voice gets quieter at any speech, and stops only at
					// words, so that a cough or a noise stops nothing.
					voiced: (voiced) => this.speaker?.duck(voiced),
					speaking: () => {
						this.trace("speaking", { reading: this.state.reading });
						this.words = true;
						this.claim();
					},
					voice: (number, played) => {
						this.known = true;
						this.played = played;
						// The speaker's echo is no one speaking.
						const voice = played ? undefined : number;
						if (voice !== this.state.voice) this.update({ voice });
						this.show();
						this.claim();
					},
					partial: (heard) => {
						this.heard = heard;
						this.show();
						this.claim();
					},
					segment: (segment) => this.heardSegment(segment),
					audio: (pcm) => this.emit("audio", pcm),
					level: (level) => this.update({ level }),
					trace: (event, data) => this.trace(event, data),
					failed: (error) => {
						this.trace("failed", { error: error.message });
						// What was heard of the segment in progress is kept, as a
						// segment of its own.
						const { hearing } = this.state;
						this.listener = null;
						this.stopping = false;
						this.yieldFloor();
						this.update({
							listener: false,
							hearing: "",
							level: 0,
							voice: undefined,
						});
						this.failure(error);
						this.modes();
						if (hearing) this.segment([{ text: hearing, voice: null }]);
					},
				},
				{
					input: this.input,
					floor: () =>
						this.speaker?.playing ? ECHO_FLOOR : Number.NEGATIVE_INFINITY,
					sounding: () => this.speaker?.playing ?? false,
				},
			);
			this.update({ listener: true, switching: null });
			this.cue("listen");
			this.modes();
		} catch (error) {
			this.update({ switching: null });
			this.failure(error as Error);
		}
	}

	/** Whether what is heard now may be the person's: not the speaker's
	 * echo, and while the speaker plays, of a voice known not to be its. */
	private mayBeTheirs(): boolean {
		if (this.played) return false;
		return this.known || !this.speaker?.playing;
	}

	/** Shows what was heard of the segment in progress, once it may be the
	 * person's. */
	private show(): void {
		const hearing = this.heard;
		if (hearing === this.state.hearing || !this.mayBeTheirs()) return;
		// Scribe's partials repeat the whole segment so far, mostly
		// revising only its end, so a partial keeps what it adds to
		// the start it shares with the last one, `kept` characters
		// long where that is shorter than the last one, and its
		// whole `text` where they share nothing, as after a send.
		const last = this.state.hearing ?? "";
		let kept = 0;
		while (
			kept < last.length &&
			kept < hearing.length &&
			last[kept] === hearing[kept]
		)
			kept++;
		this.trace(
			"partial",
			kept === 0
				? { text: hearing }
				: kept === last.length
					? { added: hearing.slice(kept) }
					: { kept, added: hearing.slice(kept) },
		);
		this.update({ hearing });
	}

	/** A segment heard: its words go out, but for the speaker's echo, and
	 * all of them if it never got loud while the speaker played, which show
	 * for a while, to send if they were the person's. A backchannel, few
	 * words while the speaker played that only signal listening, goes out as
	 * one, and the speaker reads on. */
	private heardSegment({ words, loud }: Segment): void {
		const echo = text(words.filter((word) => word.played));
		const theirs = words.filter((word) => !word.played);
		const said = text(theirs);
		if (echo) this.trace("echo", { text: echo });
		const backchannel =
			wordsOf(said).length > 0 &&
			wordsOf(said).every((word) => BACKCHANNEL.has(word));
		const missed: State["missed"] = !loud
			? { text: text(words), why: "quiet" }
			: !/\w/.test(said)
				? { text: echo, why: "echo" }
				: null;
		if (missed?.text) {
			this.trace("missed", missed);
			clearTimeout(this.missedClear);
			this.update({ missed });
			this.missedClear = setTimeout(
				() => this.update({ missed: null }),
				MISSED * 1000,
			);
		}
		const sent = loud && /\w/.test(said) ? theirs : [];
		this.trace("segment", { text: text(sent), backchannel });
		if (sent.length > 0) this.update({ missed: null });
		this.segment(sent, backchannel);
	}

	/** Opens listening again, if it is on and nothing is being heard, for
	 * what it hears with to change. */
	private async reopen(): Promise<void> {
		if (!this.state.listener || this.state.hearing || this.state.switching)
			return;
		this.listener?.close();
		this.listener = null;
		this.update({ listener: false, level: 0 });
		this.restoring = true;
		await this.listen(true);
		this.restoring = false;
		// Listening that failed to reopen is off, which the others must know.
		if (!this.state.listener) this.modes();
	}

	private setSpeaker(on: boolean): void {
		if (on === this.state.speaker || this.state.switching) return;
		if (on) {
			const speaker = new Speaker();
			speaker.changed = (reading) => {
				this.trace("reading", { id: reading });
				// A message read right after another, so that the break
				// between the two is heard.
				const before = this.state.reading;
				const next =
					reading !== null &&
					(before !== null || performance.now() - this.readEnded < NEXT * 1000);
				if (next) this.ring("next");
				if (reading === null && before !== null)
					this.readEnded = performance.now();
				this.update({ reading });
				clearInterval(this.silent);
				if (reading !== null) {
					const since = performance.now();
					this.silent = setInterval(() => {
						if (speaker.reading !== reading || speaker.progress() > 0)
							return clearInterval(this.silent);
						const why = speaker.why();
						const waited = (performance.now() - since) / 1000;
						if (
							why.came === null
								? waited < SILENT.coming
								: why.came < SILENT.came
						)
							return;
						clearInterval(this.silent);
						this.trace("silent", {
							id: reading,
							// How long ago the host last pulled what to play, if ever.
							pulled: Number.isFinite(this.pulled)
								? Math.round(performance.now() - this.pulled)
								: "never",
							...why,
						});
					}, 1000);
				}
			};
			speaker.played = (samples) => this.listener?.played(samples);
			speaker.done = (heard) => {
				this.trace("heard", {
					id: heard.id,
					whole: heard.whole,
					why: heard.why,
					chars: heard.text.length,
				});
				this.emit(
					"heard",
					heard.why === "cut" ? { ...heard, by: this.by } : heard,
				);
			};
			speaker.player.flush = () => this.flush();
			speaker.failed = (error) => {
				this.trace("failed", { error: error.message });
				this.failure(error);
			};
			speaker.use(this.synthesize?.() ?? null);
			this.speaker = speaker;
		} else {
			this.speaker?.close();
			this.speaker = null;
		}
		this.update({ speaker: on, reading: null, held: false });
		this.cue(on ? "speak" : "unspeak");
		this.modes();
	}

	private closeListener(): void {
		this.stopping = false;
		this.listener?.close();
		this.listener = null;
		this.update({ hearing: "", level: 0, voice: undefined });
		this.yieldFloor();
	}

	/** Ends the floor taken, as listening closes with no words still to
	 * come: the speaker reads on. */
	private yieldFloor(): void {
		this.words = false;
		if (!this.floor) return;
		this.floor = false;
		this.speaker?.resume();
	}

	/** Pauses the speaker for the words in progress, once they may take the floor. */
	private claim(): void {
		if (!this.words || this.floor || !this.mayBeTheirs()) return;
		const { names, voice } = this.state;
		if (Object.keys(names).length > 0 && !(voice != null && voice in names))
			return;
		if (this.speaker?.playing) {
			const said = wordsOf(this.heard);
			if (said.length < FLOOR_WORDS && !said.some((word) => STOP.has(word)))
				return;
		}
		this.floor = true;
		this.by = voice ?? null;
		this.trace("floor", { voice, reading: this.state.reading });
		this.speaker?.pause();
	}

	/** Sends the words that didn't count, as the person's. */
	sendMissed(): void {
		const missed = this.state.missed;
		if (!missed) return;
		clearTimeout(this.missedClear);
		this.trace("send missed", missed);
		this.update({ missed: null });
		this.ring("sent");
		this.sentAt = performance.now();
		this.emit("speech", {
			text: tagged(missed.text),
			voices: [],
			backchannel: false,
			missed: true,
		});
	}

	/** Pauses or resumes reading aloud. */
	hold(held: boolean): void {
		this.trace("hold", { on: held });
		this.ring("press");
		this.speaker?.hold(held);
		this.update({ held });
	}

	/** Skips the message being read. */
	skip(): void {
		this.trace("skip");
		this.ring("press");
		this.speaker?.skip();
	}

	close(): void {
		clearTimeout(this.working);
		clearTimeout(this.readCue);
		clearTimeout(this.missedClear);
		clearInterval(this.silent);
		this.listener?.close();
		this.speaker?.close();
	}

	/** A segment over: its words go out, and if they took the floor, the
	 * speaker stops what it was saying; else it reads on. */
	private segment(words: Said[], backchannel = false): void {
		const floor = this.floor;
		this.words = false;
		this.floor = false;
		this.heard = "";
		this.known = false;
		this.played = false;
		this.update({ hearing: "", voice: undefined });
		if (this.stopping) this.closeListener();
		const cut = floor ? (this.speaker?.interrupt() ?? []) : [];
		if (!floor) this.speaker?.resume();
		if (words.length === 0) return;
		this.trace("send", { text: text(words), heard: cut, backchannel });
		this.ring("sent");
		this.sentAt = performance.now();
		const voices = [...new Set(words.map((word) => word.voice))];
		this.emit("speech", {
			text: tagged(tag(words)),
			voices,
			backchannel,
			missed: false,
		});
	}

	private modes(): void {
		const { listener, speaker } = this.state;
		this.emit("modes", { listener, speaker });
	}

	private update(change: Partial<State>): void {
		this.state = { ...this.state, ...change };
		this.emit("state", this.state);
	}
}
