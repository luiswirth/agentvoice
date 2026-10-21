// Voice as a whole: the listener and the speaker, each on or off on its own,
// and ending turns automatically as a switch of its own. Both on is a
// conversation, the speaker alone spoken answers, the listener alone
// dictation. What the person says gathers into a draft, which goes out as
// one chat message: at a segment's end if turns end automatically, else
// when the person sends it. Nothing the person says is lost: every
// transcript, sent or dropped, is kept in this browser, the last to copy.
import { holdAudioSession } from "./audio.ts";
import { Listener } from "./listener.ts";
import { HEARD, MODES, type Modes, type Session, spoken } from "./protocol.ts";
import { Speaker } from "./speaker.ts";

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
	error: string | null;
};

const TRANSCRIPTS = "voice-transcripts";

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
			this.listener = await Listener.open(this.key, {
				speaking: () => this.speaker?.pause(),
				partial: (hearing) => this.set({ hearing }),
				segment: (text) => this.segment(text),
				level: (level) => this.set({ level }),
				failed: (error) => {
					this.listener = null;
					this.set({
						listener: false,
						hearing: "",
						level: 0,
						error: error.message,
					});
					void this.modes();
				},
			});
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
			speaker.changed = (reading) => this.set({ reading });
			speaker.failed = (error) => this.set({ error: error.message });
			this.speaker = speaker;
		} else {
			this.speaker?.close();
			this.speaker = null;
		}
		this.set({ speaker: on, reading: null, held: false });
		await this.modes();
	}

	setAutoEnd(autoEnd: boolean): void {
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
		this.queue(async () => {
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
		this.speaker?.hold(held);
		this.set({ held });
	}

	/** Reads the others' last message again, turning the speaker on if it is off.
	 * Call it from a click, since it may start the page's audio. */
	async replay(): Promise<void> {
		if (!this.state.speaker) await this.setSpeaker(true);
		this.hold(false);
		this.speaker?.replay();
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

	private modes(): Promise<void> {
		const { listener, speaker } = this.state;
		holdAudioSession(listener || speaker);
		const modes: Modes = { listener, speaker };
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
