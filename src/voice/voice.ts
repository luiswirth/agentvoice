// Voice as a whole: the listener and the speaker, each on or off on its own,
// and ending turns automatically as a switch of its own. Both on is a
// conversation, the speaker alone spoken answers, the listener alone
// dictation. What the person says gathers into a draft, which goes out as
// one chat message: at a segment's end if turns end automatically, else
// when the person sends it. Nothing the person says is lost: every
// transcript, sent or dropped, is kept in this browser, the last to copy.
// Words take the floor, pausing the speaker, and a message they end in
// drops what was not heard of the agent's: any voice's words while the agent
// named none, only a named voice's once it named any. What happens is heard
// as short cues, so that voice seems responsive while nothing is said.
import { Activity, type Progress } from "./activity.ts";
import { holdAudioSession } from "./audio.ts";
import { KeyRefused } from "./elevenlabs.ts";
import { Listener } from "./listener.ts";
import { holdMedia } from "./media.ts";
import {
	HEARD,
	MODES,
	type Modes,
	NAMES,
	type Names,
	names,
	type Session,
	spoken,
} from "./protocol.ts";
import { type Cue, play, setSounds, soundsOn } from "./sounds.ts";
import { Speaker } from "./speaker.ts";
import { TRACE, Trace } from "./trace.ts";

export type VoiceState = Modes & {
	/** Whether a turn ends by itself, after a pause. */
	autoEnd: boolean;
	/** A switch whose click is still under way. */
	switching: "listener" | "speaker" | null;
	/** What is heard of the segment in progress. */
	hearing: string;
	/** What was heard and not yet sent. */
	draft: string;
	/** How loud the microphone is, from 0 to 1. */
	level: number;
	/** The message being read aloud, by its entry. */
	reading: number | null;
	/** Whether the person paused reading aloud. */
	held: boolean;
	/** The others' last message, which the speaker reads or can read again. */
	message: string | null;
	/** The person's last transcript, sent or dropped. */
	last: string | null;
	/** The languages the person speaks, most likely first, as ISO 639-1
	 * codes: none to have Scribe detect it. Kept in this browser. */
	languages: string[];
	/** Whether the page sends its trace into the session. */
	sharing: boolean;
	/** Who the agent named the voices, by number. */
	names: Names;
	/** Where the person's last message is: sent, or read by the agent, who
	 * works on it until it answers. */
	progress: Progress;
	/** Whether what happens is heard as cues. Kept in this browser. */
	sounds: boolean;
	/** The voice heard now, by its number, null for one without a number,
	 * undefined while none is heard. */
	voice?: number | null | undefined;
	error: string | null;
	/** Whether the error is ElevenLabs refusing the key, which another key
	 * fixes. */
	refused: boolean;
};

/** The state that shows `error`. */
function failure(error: Error): Pick<VoiceState, "error" | "refused"> {
	play("problem");
	return { error: error.message, refused: error instanceof KeyRefused };
}

/** The pauses between the cues that the agent is still working, in seconds:
 * close at first, when an answer may still come any moment, then sparse,
 * the last repeating. */
const WORKING = [3, 5, 8, 12, 20];

const TRANSCRIPTS = "voice-transcripts";
const LANGUAGES = "voice-languages";

/** How loud, in dBFS, the person must get to count while the speaker plays:
 * the speaker's echo left over measured -42 to -57, the person's speech -12
 * to -13, and -35 within 0.25 s of its start. */
const ECHO_FLOOR = -35;

function transcripts(): string[] {
	try {
		return JSON.parse(localStorage.getItem(TRANSCRIPTS) ?? "[]") as string[];
	} catch {
		return [];
	}
}

export class Voice {
	private readonly session: Session;
	private readonly name: string;
	private readonly key: string;
	private listener: Listener | null = null;
	private speaker: Speaker | null = null;
	/** What happens to the draft once the segment in progress ends: the
	 * person sent or dropped it while still being heard. */
	private ending: "send" | "drop" | null = null;
	/** Whether the segment in progress has words, and whether they took the floor. */
	private words = false;
	private floor = false;
	/** The log's order is the order things were said, so sends go one after another. */
	private sent: Promise<unknown> = Promise.resolve();
	private readonly watchers = new Set<() => void>();
	private readonly trace = new Trace();
	/** Where the tab keeps the modes, so that a reload keeps them. */
	private readonly modesKey = `voice-modes ${location.href}`;
	/** While modes come back on as they were: as the page opens, or as
	 * listening reopens. */
	private restoring = false;
	private readonly unsubscribe: () => void;
	private readonly activity: Activity;
	/** The next cue that the agent is still working, while it is. */
	private working: ReturnType<typeof setTimeout> | undefined;
	/** When the cue of sending last played, by `performance.now()`. */
	private sentAt = 0;
	state: VoiceState = {
		listener: false,
		speaker: false,
		autoEnd: true,
		switching: null,
		hearing: "",
		draft: "",
		level: 0,
		reading: null,
		held: false,
		message: null,
		last: transcripts()[0] ?? null,
		languages: JSON.parse(localStorage.getItem(LANGUAGES) ?? "[]") as string[],
		sharing: this.trace.sharing,
		names: {},
		progress: null,
		sounds: soundsOn(),
		error: null,
		refused: false,
	};

	/** `name` is the person's in the session, `key` their ElevenLabs key. */
	constructor(session: Session, name: string, key: string) {
		this.session = session;
		this.name = name;
		this.key = key;
		const message = () =>
			this.set({
				message:
					session.log.findLast((entry) => entry.from !== name && spoken(entry))
						?.text ?? null,
			});
		const named = () => {
			const entry = session.log.findLast((e) => e.type.startsWith(NAMES));
			this.set({ names: names(entry?.text) });
		};
		message();
		named();
		this.unsubscribe = session.subscribe({
			entry: (entry) => {
				message();
				if (entry.type.startsWith(NAMES)) {
					named();
					this.trace.event("names", this.state.names);
				}
			},
		});
		this.activity = new Activity(session, name, {
			// An agent waiting on a receive reads at once, so its cue waits
			// for the cue of sending to end.
			read: () =>
				setTimeout(
					() => play("read"),
					Math.max(0, this.sentAt + 250 - performance.now()),
				),
			// A message read aloud is heard as it is read, so its cue would
			// only come before the voice.
			message: () => {
				if (!this.state.speaker) play("message");
			},
			other: () => {
				play("other");
				if (this.working !== undefined) this.work(0);
			},
			joined: () => play("joined"),
			left: () => play("left"),
			progress: (progress) => {
				this.trace.event("progress", { progress });
				this.set({ progress });
				clearTimeout(this.working);
				this.working = undefined;
				if (progress === "working") this.work(0);
			},
		});
		// The speaker is on from the start, the listener off, unless the tab
		// had them otherwise before a reload. Their audio starts at the first
		// gesture on the page.
		const kept: Partial<Modes> = JSON.parse(
			sessionStorage.getItem(this.modesKey) ?? "{}",
		);
		// The modes go out once both are on, not one at a time.
		this.restoring = true;
		const speaker = (kept.speaker ?? true) && this.setSpeaker(true);
		const listener = kept.listener && this.setListener(true);
		void Promise.all([speaker, listener]).then(() => {
			this.restoring = false;
			return this.modes();
		});
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
			if (!busy) play("working");
			this.work(step + 1);
		}, pause * 1000);
	}

	/** Turns the cues on or off. */
	setSounds(sounds: boolean): void {
		setSounds(sounds);
		this.set({ sounds });
		if (sounds) play("press");
	}

	/** A cue for the person's own act, which plays only for theirs, not
	 * while modes come back on as they were. */
	private cue(cue: Cue): void {
		if (!this.restoring) play(cue);
	}

	/** For React's `useSyncExternalStore`. */
	watch = (watcher: () => void): (() => void) => {
		this.watchers.add(watcher);
		return () => this.watchers.delete(watcher);
	};

	/** How loud the speaker sounds now, from 0 to 1: read it as often as
	 * needed, since it changes too fast for `state`. */
	speakerLevel(): number {
		return this.speaker?.level() ?? 0;
	}

	/** Call it from a click, since it starts the page's audio. */
	async setListener(on: boolean): Promise<void> {
		if (on === this.state.listener || this.state.switching) return;
		if (!on) {
			this.listener?.close();
			this.listener = null;
			this.set({ listener: false, hearing: "", level: 0, voice: undefined });
			this.cue("unlisten");
			return this.modes();
		}
		this.set({ switching: "listener", error: null, refused: false });
		this.words = false;
		this.floor = false;
		try {
			this.listener = await Listener.open(
				this.key,
				{
					// The voice gets quieter at any speech, and stops only at
					// words, so that a cough or a noise stops nothing.
					voiced: (voiced) => this.speaker?.duck(voiced),
					speaking: () => {
						this.trace.event("speaking", { reading: this.state.reading });
						this.words = true;
						this.claim();
					},
					voice: (voice) => {
						if (voice !== this.state.voice) this.set({ voice });
						this.claim();
					},
					partial: (hearing) => {
						// Scribe's partials repeat the whole segment so far, so a
						// partial that only extends the last one keeps what it adds.
						const last = this.state.hearing;
						this.trace.event(
							"partial",
							last && hearing.startsWith(last)
								? { added: hearing.slice(last.length) }
								: { text: hearing },
						);
						this.set({ hearing });
					},
					segment: (text) => {
						this.trace.event("segment", { text });
						this.segment(text);
					},
					audio: (pcm) => this.trace.hear(pcm),
					level: (level) => this.set({ level }),
					trace: (event, data) => this.trace.event(event, data),
					failed: (error) => {
						this.trace.event("failed", { error: error.message });
						this.listener = null;
						this.set({
							listener: false,
							hearing: "",
							level: 0,
							voice: undefined,
							...failure(error),
						});
						void this.modes();
					},
				},
				() => (this.speaker?.playing ? ECHO_FLOOR : Number.NEGATIVE_INFINITY),
				(text) => this.speaker?.echoes(text) ?? false,
				this.state.languages,
			);
			this.set({ listener: true, switching: null });
			this.cue("listen");
			await this.modes();
		} catch (error) {
			this.set({ switching: null, ...failure(error as Error) });
		}
	}

	/** Sets the languages the person speaks. Listening hears them from its
	 * next start, at once while nothing is being heard. */
	async setLanguages(languages: string[]): Promise<void> {
		this.trace.event("languages", { languages });
		play("press");
		localStorage.setItem(LANGUAGES, JSON.stringify(languages));
		this.set({ languages });
		if (!this.state.listener || this.state.hearing || this.state.switching)
			return;
		this.listener?.close();
		this.listener = null;
		this.set({ listener: false, level: 0 });
		this.restoring = true;
		await this.setListener(true);
		this.restoring = false;
		// Listening that failed to reopen is off, which the others must know.
		if (!this.state.listener) await this.modes();
	}

	/** Call it from a click, since it starts the page's audio. */
	async setSpeaker(on: boolean): Promise<void> {
		if (on === this.state.speaker || this.state.switching) return;
		if (on) {
			const speaker = new Speaker(this.session, this.name, this.key);
			speaker.changed = (reading) => {
				this.trace.event("reading", { n: reading });
				this.set({ reading });
			};
			speaker.failed = (error) => {
				this.trace.event("failed", { error: error.message });
				this.set(failure(error));
			};
			this.speaker = speaker;
		} else {
			this.speaker?.close();
			this.speaker = null;
		}
		this.set({ speaker: on, reading: null, held: false });
		this.cue(on ? "speak" : "unspeak");
		await this.modes();
	}

	setAutoEnd(autoEnd: boolean): void {
		this.trace.event("autoEnd", { on: autoEnd });
		play("press");
		this.set({ autoEnd });
		if (autoEnd && this.state.draft && !this.state.hearing) this.send();
	}

	/** Pauses the speaker for the words in progress, once they may take the floor. */
	private claim(): void {
		if (!this.words || this.floor) return;
		const { names, voice } = this.state;
		if (Object.keys(names).length > 0 && !(voice != null && voice in names))
			return;
		this.floor = true;
		this.trace.event("floor", { voice, reading: this.state.reading });
		this.speaker?.pause();
	}

	/** Sends the draft, with what is still being heard once it is, dropping
	 * what was not heard of the agent's messages unless `interrupt` is off. */
	send(interrupt = true): void {
		if (this.finishing("send")) return;
		const text = join(this.state.draft, this.state.hearing);
		this.set({ draft: "", hearing: "" });
		if (!text) {
			this.speaker?.resume();
			return;
		}
		this.keep(text);
		play("sent");
		this.sentAt = performance.now();
		const heard = interrupt ? (this.speaker?.interrupt() ?? []) : [];
		if (!interrupt) this.speaker?.duck(false);
		this.trace.event("send", { text, heard });
		const trace = this.trace.take();
		this.queue(async () => {
			await this.shareTrace(trace);
			for (const entry of heard)
				await this.session.send(JSON.stringify(entry), { type: HEARD });
			await this.session.send(text, { type: "text/plain" });
		});
	}

	/** Drops the draft, with what is still being heard once it is, and the
	 * speaker reads on. */
	clear(): void {
		if (this.finishing("drop")) return;
		const text = join(this.state.draft, this.state.hearing);
		this.trace.event("drop", { text });
		if (text) {
			this.keep(text);
			play("dropped");
		}
		this.set({ draft: "", hearing: "" });
		this.speaker?.resume();
	}

	/** The person's edit of the draft. */
	setDraft(draft: string): void {
		this.set({ draft });
	}

	/** Copies the last transcript, sent or dropped. */
	async copyLast(): Promise<void> {
		if (!this.state.last) return;
		await navigator.clipboard.writeText(this.state.last);
		play("press");
	}

	/** Pauses or resumes reading aloud. */
	hold(held: boolean): void {
		this.trace.event("hold", { on: held });
		play("press");
		this.speaker?.hold(held);
		this.set({ held });
	}

	/** Reads the others' last message again, turning the speaker on if it is off.
	 * Call it from a click, since it may start the page's audio. */
	async replay(): Promise<void> {
		if (!this.state.speaker) await this.setSpeaker(true);
		this.hold(false);
		this.trace.event("replay");
		this.speaker?.replay();
	}

	/** Shares the page's trace with the session, at once what it kept so far,
	 * or stops. */
	share(on: boolean): void {
		this.trace.share(on);
		play("press");
		this.set({ sharing: on });
		const trace = this.trace.take();
		this.queue(() => this.shareTrace(trace));
	}

	/** Sends a trace taken, with the audio heard, each stretch named by its
	 * start. */
	private async shareTrace({ events, audio }: ReturnType<Trace["take"]>) {
		if (events.length > 0)
			await this.session.send(JSON.stringify(events), { type: TRACE });
		for (const { start, wav } of audio)
			await this.session.send(wav, { filename: `heard ${start}.wav` });
	}

	private keep(text: string): void {
		const kept = [text, ...transcripts()].slice(0, 20);
		localStorage.setItem(TRANSCRIPTS, JSON.stringify(kept));
		this.set({ last: text });
	}

	/** Ends the segment in progress, if one is, and leaves `ending` for when
	 * it has. */
	private finishing(ending: "send" | "drop"): boolean {
		if (!this.state.hearing || !this.listener?.finish()) return false;
		this.ending = ending;
		return true;
	}

	/** Skips the message being read. */
	skip(): void {
		this.trace.event("skip");
		play("press");
		this.speaker?.skip();
	}

	close(): void {
		this.unsubscribe();
		this.activity.close();
		clearTimeout(this.working);
		this.listener?.close();
		this.speaker?.close();
		holdAudioSession(false);
	}

	private segment(text: string): void {
		const ending = this.ending;
		const floor = this.floor;
		this.ending = null;
		this.words = false;
		this.floor = false;
		this.set({
			hearing: "",
			draft: join(this.state.draft, text),
			voice: undefined,
		});
		if (ending === "drop") this.clear();
		else if (ending === "send") this.send();
		else if (this.state.autoEnd) this.send(floor);
		else if (!this.state.draft) this.speaker?.resume();
		else if (!floor) this.speaker?.duck(false);
	}

	/** Play and pause from the system's media controls: sends a draft, else
	 * pauses or resumes reading, else turns listening on or off. */
	mediaToggle = (): void => {
		if (!this.state.autoEnd && (this.state.draft || this.state.hearing))
			this.send();
		else if (this.state.reading !== null) this.hold(!this.state.held);
		else void this.setListener(!this.state.listener);
	};

	private modes(): Promise<void> {
		const { listener, speaker } = this.state;
		holdAudioSession(listener || speaker);
		holdMedia(listener || speaker, {
			toggle: this.mediaToggle,
			next: () => this.skip(),
			previous: () => void this.replay(),
		});
		const modes: Modes = { listener, speaker };
		if (this.restoring) return Promise.resolve();
		sessionStorage.setItem(this.modesKey, JSON.stringify(modes));
		this.trace.event("modes", modes);
		return this.queue(() =>
			this.session.send(JSON.stringify(modes), { type: MODES }),
		);
	}

	private queue(send: () => Promise<unknown>): Promise<void> {
		const sent = this.sent.then(send);
		this.sent = sent.catch(() => {});
		return sent.then(
			() => {},
			(error: Error) => this.set(failure(error)),
		);
	}

	private set(change: Partial<VoiceState>): void {
		this.state = { ...this.state, ...change };
		for (const watcher of this.watchers) watcher();
	}
}

function join(a: string, b: string): string {
	return [a, b].filter(Boolean).join(" ").trim();
}
