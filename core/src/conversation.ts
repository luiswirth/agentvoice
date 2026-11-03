// A conversation by voice: the listener and the speaker, each on or off on
// its own, and ending turns automatically as a switch of its own. Both on is
// a conversation, the speaker alone read aloud, the listener alone
// dictation. What the person says gathers into a draft, which goes out as
// one turn: at a segment's end if turns end automatically, else when the
// person sends it.
// Words take the floor, pausing the speaker, and a turn they end in drops
// what was not heard of the agents' messages: any voice's words while no
// voice is named, only a named voice's once any is. The voice the speaker
// plays is its own, heard back as echo, which never takes the floor and is
// never sent. While the speaker plays, words take the floor only once their
// voice is known, and only a few words or a word to stop, so that the speaker
// reads on over a "mhm". Few words that only signal listening, a
// backchannel, are no turn and are not sent; other few words are. Words that
// didn't count, as its echo, too quiet or such a backchannel while it
// played, show for a while, to send. The listener only perceives, and this
// decides. What happens is heard as short cues, so that voice seems
// responsive while nothing is said.
// Ending turns only decides whether a turn goes out by itself: the listener
// only ever listens or stops, and with turns ended by hand what is said
// gathers in the draft until the person sends it.
// Its edges are the person's audio in, the audio to play out, the agents'
// messages in, and the person's turns out: the host carries them, and plugs
// in the tier, which transcribes and speaks.
import { type Cue, Cues } from "./cues.ts";
import { type Input, Listener, type Segment } from "./listener.ts";
import type { Reflexes } from "./reflexes.ts";
import { Resampler } from "./resampler.ts";
import { type Heard, type Message, Speaker } from "./speaker.ts";
import { memory, type Store } from "./store.ts";
import { LISTEN_RATE, type Synthesize, type Transcribe } from "./tier.ts";

/** Who the voices are, by the number of their tag in the transcript. */
export type Names = Record<string, string>;

/** What the host sets, at the start and whenever it changes. */
export type Settings = {
	/** Whether the person is heard. */
	listener: boolean;
	/** Whether the agents' messages are read aloud. */
	speaker: boolean;
	/** Whether a turn ends by itself, after a pause. */
	autoEnd: boolean;
	/** Whether what happens is heard as cues. */
	sounds: boolean;
	/** Who the voices are: a named voice can cut in, and once any is named,
	 * an unnamed one can't. */
	names: Names;
	/** How the tier hears. Listening opens it again for a new one, at once
	 * while nothing is being heard. */
	transcribe: Transcribe;
	/** How the tier speaks, null while it can't: the messages given then go
	 * unread. */
	synthesize: Synthesize | null;
};

export type Options = Partial<Settings> &
	Pick<Settings, "transcribe"> & {
		/** Where the reflexes run. */
		reflexes: Reflexes;
		/** Where the voices heard are kept, so that their numbers last. */
		store?: Store;
		/** The person's audio, which listening opens and closes. */
		input?: Input;
	};

export type State = Omit<Settings, "transcribe" | "synthesize"> & {
	/** The draft the person last deleted, to bring back, until they send or
	 * say more. */
	dropped: string | null;
	/** Listening while it opens. */
	switching: "listener" | null;
	/** What is heard of the segment in progress. */
	hearing: string;
	/** What was heard and not yet sent. */
	draft: string;
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
	 * theirs, or meant as a turn. */
	missed: { text: string; why: "echo" | "quiet" | "backchannel" } | null;
};

/** A turn of the person's, and what was heard of each message it cut in on,
 * empty for one still queued. */
export type Turn = { text: string; cut: Heard[] };

/** The person's listener and speaker, as the agents should know them. */
export type Modes = Pick<Settings, "listener" | "speaker">;

export type Events = {
	state(state: State): void;
	/** The person ended a turn, for the agents. */
	turn(turn: Turn): void;
	/** The person deleted a draft, which `undo` brings back. */
	dropped(text: string): void;
	/** Done with a message: read to its end, or dropped. */
	heard(heard: Heard): void;
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
 * makes heard: the person pressed something; their turn reached the agents;
 * an agent read it and works on it; an agent sent a message to read, or
 * anything else; someone joined or left; something failed. */
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

/** The person's audio is heard in chunks of 0.1 s. */
const CHUNK = LISTEN_RATE / 10;

/** The words of a text, lower case, without punctuation. */
function wordsOf(text: string): string[] {
	return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export class Conversation {
	private readonly reflexes: Reflexes;
	private readonly store: Store;
	private readonly input: Input | undefined;
	private transcribe: Transcribe;
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
	/** What happens to the draft once the segment in progress ends: the
	 * person sent or dropped it while still being heard, or stopped listening,
	 * which keeps it. */
	private ending: "send" | "drop" | "keep" | null = null;
	/** Whether listening is off, with the listener still finishing the
	 * segment in progress, whose words go to the draft. */
	private stopping = false;
	/** Whether the segment in progress has words, and whether they took the floor. */
	private words = false;
	private floor = false;
	/** Whether its words were too few to take the floor while the speaker
	 * played. */
	private few = false;
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
		turn: new Set(),
		dropped: new Set(),
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
	state: State;

	/** Starts as `options` set it, without the cues of turning on: listening
	 * opens at once if on, and the speaker reads what it is given from now. */
	constructor(options: Options) {
		this.reflexes = options.reflexes;
		this.store = options.store ?? memory();
		this.input = options.input;
		this.transcribe = options.transcribe;
		this.synthesize = options.synthesize ?? null;
		this.state = {
			listener: false,
			speaker: false,
			autoEnd: options.autoEnd ?? true,
			sounds: options.sounds ?? true,
			names: options.names ?? {},
			dropped: null,
			switching: null,
			hearing: "",
			draft: "",
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
		const { sounds, autoEnd, names } = change;
		if (sounds !== undefined && sounds !== this.state.sounds) {
			this.update({ sounds });
			if (sounds) this.cue("press");
		}
		if (autoEnd !== undefined && autoEnd !== this.state.autoEnd) {
			this.trace("autoEnd", { on: autoEnd });
			this.cue("press");
			this.update({ autoEnd });
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
		if (change.transcribe !== undefined) {
			this.transcribe = change.transcribe;
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
			// Words in progress still go to the draft, unsent: the person's
			// audio is heard no more, and the listener closes once they are in.
			if (this.finishing("keep")) this.stopping = true;
			else this.closeListener();
			this.update({ listener: false, level: 0 });
			this.cue("unlisten");
			this.modes();
			return;
		}
		if (this.stopping) {
			// Still finishing: it listens on, and the words go in as they would.
			this.stopping = false;
			if (this.ending === "keep") this.ending = null;
			this.update({ listener: true });
			this.emit("error", null);
			this.cue("listen");
			this.modes();
			return;
		}
		this.update({ switching: "listener" });
		this.emit("error", null);
		this.words = false;
		this.floor = false;
		this.few = false;
		this.heard = "";
		this.known = false;
		this.played = false;
		// What is heard counts from listening's start.
		this.capture = null;
		try {
			this.listener = await Listener.open(
				this.transcribe,
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
						this.listener = null;
						this.stopping = false;
						this.update({
							listener: false,
							hearing: "",
							level: 0,
							voice: undefined,
						});
						this.failure(error);
						this.modes();
					},
				},
				{
					reflexes: this.reflexes,
					store: this.store,
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

	/** A segment heard: its words go to the draft, but for the speaker's
	 * echo, all of them if it never got loud, and all of a backchannel, few
	 * words while the speaker played that only signal listening, while turns
	 * end by themselves. Those show for a while, to send if they were
	 * the person's, or meant as a turn. */
	private heardSegment({ runs, loud }: Segment): void {
		const echo = runs.filter((run) => run.played);
		const theirs = runs.filter((run) => !run.played);
		const words = (some: typeof runs) => some.map((r) => r.text).join(" ");
		if (echo.length > 0) this.trace("echo", { text: words(echo) });
		const backchannel =
			this.few &&
			!this.floor &&
			this.state.autoEnd &&
			wordsOf(words(theirs)).every((word) => BACKCHANNEL.has(word));
		const missed: State["missed"] = !loud
			? { text: words(runs), why: "quiet" }
			: theirs.length === 0
				? { text: words(echo), why: "echo" }
				: backchannel
					? { text: words(theirs), why: "backchannel" }
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
		const text = loud && !backchannel ? (this.listener?.tag(theirs) ?? "") : "";
		this.trace("segment", { text });
		if (text) this.update({ missed: null });
		this.segment(text);
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
			};
			speaker.played = (samples) => this.listener?.played(samples);
			speaker.done = (heard) => this.emit("heard", heard);
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

	/** Brings back the draft last deleted, ahead of what was said since. */
	undo(): void {
		const dropped = this.state.dropped;
		if (!dropped) return;
		this.trace("undo", { text: dropped });
		this.ring("press");
		this.update({ dropped: null, draft: join(dropped, this.state.draft) });
	}

	private closeListener(): void {
		this.stopping = false;
		this.listener?.close();
		this.listener = null;
		this.update({ hearing: "", level: 0, voice: undefined });
	}

	/** Pauses the speaker for the words in progress, once they may take the floor. */
	private claim(): void {
		if (!this.words || this.floor || !this.mayBeTheirs()) return;
		const { names, voice } = this.state;
		if (Object.keys(names).length > 0 && !(voice != null && voice in names))
			return;
		if (this.speaker?.playing) {
			const said = wordsOf(this.heard);
			if (said.length < FLOOR_WORDS && !said.some((word) => STOP.has(word))) {
				this.few = true;
				return;
			}
		}
		this.floor = true;
		this.trace("floor", { voice, reading: this.state.reading });
		this.speaker?.pause();
	}

	/** Sends the draft, with what is still being heard once it is, dropping
	 * what was not heard of the agents' messages unless `interrupt` is off. */
	send(interrupt = true): void {
		if (this.finishing("send")) return;
		const text = join(this.state.draft, this.state.hearing);
		this.update({ draft: "", hearing: "", dropped: null });
		if (!text) {
			this.speaker?.resume();
			return;
		}
		this.ring("sent");
		this.sentAt = performance.now();
		const cut = interrupt ? (this.speaker?.interrupt() ?? []) : [];
		if (!interrupt) this.speaker?.duck(false);
		this.trace("send", { text, heard: cut });
		this.emit("turn", { text, cut });
	}

	/** Sends the words that didn't count, as the person's: with the draft
	 * when turns end by hand, else at once, and the speaker reads on. */
	sendMissed(): void {
		const missed = this.state.missed;
		if (!missed) return;
		clearTimeout(this.missedClear);
		this.trace("send missed", missed);
		this.update({ missed: null, draft: join(this.state.draft, missed.text) });
		if (this.state.autoEnd && !this.state.hearing) this.send(false);
	}

	/** Drops the draft, with what is still being heard once it is, and the
	 * speaker reads on. */
	clear(): void {
		if (this.finishing("drop")) return;
		const text = join(this.state.draft, this.state.hearing);
		this.trace("drop", { text });
		if (text) {
			this.update({ dropped: text });
			this.ring("dropped");
			this.emit("dropped", text);
		}
		this.update({ draft: "", hearing: "" });
		this.speaker?.resume();
	}

	/** The person's edit of the draft. */
	edit(draft: string): void {
		this.update({ draft });
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

	/** Ends the segment in progress, if one is, and leaves `ending` for when
	 * it has. */
	private finishing(ending: "send" | "drop" | "keep"): boolean {
		if (!this.state.hearing || !this.listener?.finish()) return false;
		// Sending or dropping, once asked for, is not undone by stopping.
		if (ending !== "keep" || !this.ending) this.ending = ending;
		return true;
	}

	close(): void {
		clearTimeout(this.working);
		clearTimeout(this.readCue);
		clearTimeout(this.missedClear);
		this.listener?.close();
		this.speaker?.close();
	}

	private segment(text: string): void {
		const ending = this.ending;
		const floor = this.floor;
		this.ending = null;
		this.words = false;
		this.floor = false;
		this.few = false;
		this.heard = "";
		this.known = false;
		this.played = false;
		this.update({
			hearing: "",
			draft: join(this.state.draft, text),
			voice: undefined,
			...(text && { dropped: null }),
		});
		if (this.stopping) this.closeListener();
		if (ending === "drop") this.clear();
		else if (ending === "send") this.send();
		else if (ending === null && this.state.autoEnd) this.send(floor);
		else if (!this.state.draft) this.speaker?.resume();
		else if (!floor) this.speaker?.duck(false);
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

function join(a: string, b: string): string {
	return [a, b].filter(Boolean).join(" ").trim();
}
