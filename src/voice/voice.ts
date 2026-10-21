// Voice as a whole: the listener and the speaker, each on or off on its own,
// and ending turns automatically as a switch of its own. Both on is a
// conversation, the speaker alone spoken answers, the listener alone
// dictation. What the person says gathers into a draft, which goes out as
// one chat message: at a segment's end if turns end automatically, else
// when the person sends it.
import { holdAudioSession } from "./audio.ts";
import { Listener } from "./listener.ts";
import { HEARD, MODES, type Modes, type Session } from "./protocol.ts";
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
	/** The message being read aloud, by its entry. */
	reading: number | null;
	error: string | null;
};

export class Voice {
	private readonly session: Session;
	private readonly name: string;
	private readonly key: string;
	private listener: Listener | null = null;
	private speaker: Speaker | null = null;
	/** The draft goes out once the segment in progress ends. */
	private sending = false;
	/** The log's order is the order things were said, so sends go one after another. */
	private sent: Promise<unknown> = Promise.resolve();
	private readonly watchers = new Set<() => void>();
	state: VoiceState = {
		listener: false,
		speaker: false,
		autoEnd: true,
		switching: null,
		hearing: "",
		draft: "",
		reading: null,
		error: null,
	};

	/** `name` is the person's in the session, `key` their ElevenLabs key. */
	constructor(session: Session, name: string, key: string) {
		this.session = session;
		this.name = name;
		this.key = key;
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
			this.set({ listener: false, hearing: "" });
			return this.modes();
		}
		this.set({ switching: "listener", error: null });
		try {
			this.listener = await Listener.open(this.key, {
				speaking: () => this.speaker?.pause(),
				partial: (hearing) => this.set({ hearing }),
				segment: (text) => this.segment(text),
				failed: (error) => {
					this.listener = null;
					this.set({ listener: false, hearing: "", error: error.message });
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
		this.set({ speaker: on, reading: null });
		await this.modes();
	}

	setAutoEnd(autoEnd: boolean): void {
		this.set({ autoEnd });
		if (autoEnd && this.state.draft && !this.state.hearing) this.send();
	}

	/** Sends the draft, with what is still being heard once it is. */
	send(): void {
		if (this.state.hearing && this.listener?.finish()) {
			this.sending = true;
			return;
		}
		const text = join(this.state.draft, this.state.hearing);
		this.set({ draft: "", hearing: "" });
		this.sending = false;
		if (!text) {
			this.speaker?.resume();
			return;
		}
		const heard = this.speaker?.interrupt() ?? [];
		this.queue(async () => {
			for (const entry of heard)
				await this.session.send(JSON.stringify(entry), { type: HEARD });
			await this.session.send(text, { type: "text/plain" });
		});
	}

	/** Drops the draft, and the speaker reads on. */
	clear(): void {
		this.set({ draft: "" });
		if (!this.state.hearing) this.speaker?.resume();
	}

	/** Skips the message being read. */
	skip(): void {
		this.speaker?.skip();
	}

	close(): void {
		this.listener?.close();
		this.speaker?.close();
		holdAudioSession(false);
	}

	private segment(text: string): void {
		this.set({ hearing: "", draft: join(this.state.draft, text) });
		if (this.state.autoEnd || this.sending) this.send();
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
