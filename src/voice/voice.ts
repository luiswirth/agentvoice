// Voice as a whole: the listener and the speaker, each on or off on its own,
// and ending turns automatically as a switch of its own. Both on is a
// conversation, the speaker alone spoken answers, the listener alone
// dictation. What the person says gathers into a draft, which goes out as
// one chat message: at a segment's end if turns end automatically, else
// when the person sends it. Nothing the person says is lost: every
// transcript, sent or dropped, is kept in this browser, the last to copy.
import { holdAudioSession } from "./audio.ts";
import { Listener } from "./listener.ts";
import { holdMedia } from "./media.ts";
import { HEARD, MODES, type Modes, type Session, spoken } from "./protocol.ts";
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
	/** Whether the page sends its trace into the session. */
	sharing: boolean;
	error: string | null;
};

const TRANSCRIPTS = "voice-transcripts";

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
	/** The log's order is the order things were said, so sends go one after another. */
	private sent: Promise<unknown> = Promise.resolve();
	private readonly watchers = new Set<() => void>();
	private readonly trace = new Trace();
	private readonly unsubscribe: () => void;
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
		sharing: this.trace.sharing,
		error: null,
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
		message();
		this.unsubscribe = session.subscribe({ entry: message });
		// The speaker is on from the start, the listener off.
		void this.setSpeaker(true);
	}

	/** For React's `useSyncExternalStore`. */
	watch = (watcher: () => void): (() => void) => {
		this.watchers.add(watcher);
		return () => this.watchers.delete(watcher);
	};

	/** Call it from a click, since it starts the page's audio. */
	async setListener(on: boolean): Promise<void> {
		if (on === this.state.listener || this.state.switching) return;
		if (!on) {
			this.listener?.close();
			this.listener = null;
			this.set({ listener: false, hearing: "", level: 0 });
			return this.modes();
		}
		this.set({ switching: "listener", error: null });
		try {
			this.listener = await Listener.open(
				this.key,
				{
					// The voice gets quieter at any speech, and stops only at
					// words, so that a cough or a noise stops nothing.
					voiced: (voiced) => this.speaker?.duck(voiced),
					speaking: () => {
						this.trace.event("speaking", { reading: this.state.reading });
						this.speaker?.pause();
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
							error: error.message,
						});
						void this.modes();
					},
				},
				() => (this.speaker?.playing ? ECHO_FLOOR : Number.NEGATIVE_INFINITY),
			);
			this.set({ listener: true, switching: null });
			await this.modes();
		} catch (error) {
			this.set({ switching: null, error: (error as Error).message });
		}
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
				this.set({ error: error.message });
			};
			this.speaker = speaker;
		} else {
			this.speaker?.close();
			this.speaker = null;
		}
		this.set({ speaker: on, reading: null, held: false });
		await this.modes();
	}

	setAutoEnd(autoEnd: boolean): void {
		this.trace.event("autoEnd", { on: autoEnd });
		this.set({ autoEnd });
		if (autoEnd && this.state.draft && !this.state.hearing) this.send();
	}

	/** Sends the draft, with what is still being heard once it is. */
	send(): void {
		if (this.finishing("send")) return;
		const text = join(this.state.draft, this.state.hearing);
		this.set({ draft: "", hearing: "" });
		if (!text) {
			this.speaker?.resume();
			return;
		}
		this.keep(text);
		const heard = this.speaker?.interrupt() ?? [];
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
		if (text) this.keep(text);
		this.set({ draft: "", hearing: "" });
		this.speaker?.resume();
	}

	/** The person's edit of the draft. */
	setDraft(draft: string): void {
		this.set({ draft });
	}

	/** Copies the last transcript, sent or dropped. */
	async copyLast(): Promise<void> {
		if (this.state.last) await navigator.clipboard.writeText(this.state.last);
	}

	/** Pauses or resumes reading aloud. */
	hold(held: boolean): void {
		this.trace.event("hold", { on: held });
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
		this.speaker?.skip();
	}

	close(): void {
		this.unsubscribe();
		this.listener?.close();
		this.speaker?.close();
		holdAudioSession(false);
	}

	private segment(text: string): void {
		const ending = this.ending;
		this.ending = null;
		this.set({ hearing: "", draft: join(this.state.draft, text) });
		if (ending === "drop") this.clear();
		else if (ending === "send" || this.state.autoEnd) this.send();
		else if (!this.state.draft) this.speaker?.resume();
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
			(error: Error) => this.set({ error: error.message }),
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
