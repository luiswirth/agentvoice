// Voice in the page: the core's conversation, carried over a polylogue
// session, with the browser's microphone and speaker. The page reads the
// agents' messages from the log into it, and sends the person's turns and
// modes into the log, as voice's protocol has them. Nothing the person says
// is lost: every transcript, sent or dropped, is kept in this browser, the
// last to copy. Transcription and speech synthesis run on ElevenLabs or on
// an engine in the session, the tier the person chooses.
import {
	Conversation,
	type Fact,
	type Heard,
	type State,
	type Store,
	type Synthesizer,
	type Transcriber,
	type Transcript,
} from "voice-core";
import { Activity, type Progress } from "./activity.ts";
import {
	audioBlocked,
	holdAudioSession,
	Microphone,
	Output,
	watchAudio,
} from "./audio.ts";
import { KeyRefused, Scribe, Speech } from "./elevenlabs.ts";
import {
	Engines,
	LocalSynthesizer,
	LocalTranscriber,
	voiceOrder,
} from "./local.ts";
import { holdMedia } from "./media.ts";
import {
	agent,
	type Entry,
	MODES,
	type Modes,
	NAMES,
	type Names,
	names,
	type Session,
	speakers,
	spoken,
	type Tier,
} from "./protocol.ts";
import { reflexes } from "./reflexes.ts";
import { recording, TRACE, Trace } from "./trace.ts";
import { zip } from "./zip.ts";

export type VoiceState = Omit<State, "reading"> & {
	/** The message being read aloud, by its entry. */
	reading: number | null;
	/** The person's last transcript, sent or dropped. */
	last: string | null;
	/** The languages the person speaks, most likely first, as ISO 639-1
	 * codes: none to have Scribe detect it. Kept in this browser. */
	languages: string[];
	/** Whether the page sends its trace into the session. */
	sharing: boolean;
	/** Where the person's last message is: sent, or read by the agent, who
	 * works on it until it answers. */
	progress: Progress;
	/** The modes, and the tier the person chose. */
	tier: Tier;
	error: string | null;
	/** Whether the error is ElevenLabs refusing the key, which another key
	 * fixes. */
	refused: boolean;
	/** Whether an engine is in the session, which the local tier needs. */
	engine: boolean;
	/** The voices the engine speaks with, as it offered them. */
	engineVoices: string[];
	/** The engine's voice the agent speaks with: the one last chosen in this
	 * browser, if the engine has it, else the engine's first. */
	engineVoice: string | null;
	/** Whether the tier can speak now: an engine is in, or there is a key. */
	ready: boolean;
	/** Whether the browser holds the page's audio until a gesture on it, as
	 * after a reload: until then the speaker is not heard, and the
	 * microphone hears nothing. Any tap or key on the page starts it. */
	blocked: boolean;
};

const TIER = "voice-tier";

/** Where transcription and speech synthesis run, as last chosen in this
 * browser; else, in a browser that never chose, as a page in the session `log`
 * last had it, so that the person's second device starts where the first is;
 * else local. */
export function chosenTier(log: readonly Entry[] = []): Tier {
	const chosen = localStorage.getItem(TIER);
	if (chosen !== null) return chosen === "elevenlabs" ? "elevenlabs" : "local";
	for (const entry of log.toReversed()) {
		if (!entry.type.startsWith(MODES)) continue;
		try {
			const { tier } = JSON.parse(entry.text ?? "") as Partial<Modes>;
			if (tier === "elevenlabs" || tier === "local") return tier;
		} catch {}
	}
	return "local";
}

export function chooseTier(tier: Tier): void {
	localStorage.setItem(TIER, tier);
}

const ENGINE_VOICE = "voice-engine-voice";
const TRANSCRIPTS = "voice-transcripts";
const LANGUAGES = "voice-languages";
const AUTO_END = "voice-auto-end";
const SOUNDS = "voice-sounds";

/** How long before the speaker started a message may have arrived and
 * still be read, in seconds: one that came during a reload. */
const RECENT = 10;

function transcripts(): string[] {
	try {
		return JSON.parse(localStorage.getItem(TRANSCRIPTS) ?? "[]") as string[];
	} catch {
		return [];
	}
}

/** What the core keeps, in this browser, for the page's link, so that a
 * reload keeps it and another session never gets it. */
function kept(): Store {
	const key = (name: string) => `voice-${name} ${location.href}`;
	return {
		get: (name) => localStorage.getItem(key(name)),
		set: (name, value) => localStorage.setItem(key(name), value),
	};
}

/** Voice as the page has it from joining the session: it sends its modes at
 * once, and its speaker, on by default, reads what the others send once the
 * tier can speak. It opens no microphone until the listener is turned on, or
 * a reload of a tab where it was on turns it back on, and plays nothing
 * before the first gesture on the page. */
export class Voice {
	private readonly session: Session;
	private readonly name: string;
	private key: string | null;
	private readonly engines: Engines;
	private readonly core: Conversation;
	private output: Output | null = null;
	private microphone: Microphone | null = null;
	/** Whether listening waits, as while there is no one to talk with: the
	 * microphone stays closed, and whether the person wants it on is kept
	 * for when the wait ends. It waits from the start, so that listening
	 * kept from before a reload opens only once there is someone to hear. */
	private standing = true;
	/** Whether the person wants to listen, while listening waits. */
	private wanted = false;
	/** Whether the core has the tier to speak with, for the speaker on now. */
	private armed = false;
	/** The last entry before the speaker came on. */
	private started = 0;
	/** The log's order is the order things were said, so sends go one after another. */
	private sent: Promise<unknown> = Promise.resolve();
	/** The modes the others were told last. */
	private told: string | null = null;
	private readonly watchers = new Set<() => void>();
	private readonly trace = new Trace();
	/** Where the tab keeps the modes, so that a reload keeps them. */
	private readonly modesKey = `voice-modes ${location.href}`;
	/** Where the tab keeps the last message it is done with, so that a reload
	 * reads none of them again. */
	private readonly readKey = `voice-read ${location.href}`;
	private readonly unsubscribe: () => void;
	private readonly activity: Activity;
	/** What is the page's own, beside the core's state. */
	private own: Omit<VoiceState, keyof State>;
	state: VoiceState;
	private readonly unwatchAudio = watchAudio(() => {
		const blocked = audioBlocked();
		if (blocked === this.own.blocked) return;
		this.trace.event("audio", { blocked });
		this.set({ blocked });
	});

	/** `name` is the person's in the session, `key` their ElevenLabs key,
	 * which only what runs on ElevenLabs needs, and `setKey` gives later. */
	constructor(session: Session, name: string, key: string | null) {
		this.session = session;
		this.name = name;
		this.key = key;
		this.own = {
			last: transcripts()[0] ?? null,
			languages: JSON.parse(
				localStorage.getItem(LANGUAGES) ?? "[]",
			) as string[],
			sharing: this.trace.sharing,
			progress: null,
			tier: chosenTier(session.log),
			error: null,
			refused: false,
			engine: false,
			engineVoices: [],
			engineVoice: null,
			ready: false,
			blocked: audioBlocked(),
		};
		// Both are on from the start, unless the tab had them otherwise
		// before a reload: listening waits for someone to talk with, and its
		// audio, as the speaker's, starts at the first gesture on the page.
		const modes: Partial<Modes> = JSON.parse(
			sessionStorage.getItem(this.modesKey) ?? "{}",
		);
		this.wanted = modes.listener ?? true;
		const speaker = modes.speaker ?? true;
		this.core = new Conversation({
			transcribe: (heard) => this.transcribe(heard),
			reflexes,
			store: kept(),
			input: {
				open: async (cut) => {
					this.sound();
					this.microphone = await Microphone.open(
						(pcm, rate) => this.core.hear(pcm, rate),
						() => cut(new Error("The microphone was cut off.")),
					);
				},
				close: () => {
					this.microphone?.close();
					this.microphone = null;
				},
			},
			speaker,
			autoEnd: localStorage.getItem(AUTO_END) !== "false",
			sounds: localStorage.getItem(SOUNDS) !== "off",
			names: this.names(),
		});
		this.state = this.merged();
		if (speaker) this.sound();
		this.core.on("state", () => this.set({}));
		this.core.on("trace", (event, data) => this.trace.event(event, data));
		this.core.on("audio", (pcm) => this.trace.hear(pcm));
		this.core.on("error", (error) =>
			this.set(
				error === null
					? { error: null, refused: false }
					: { error: error.message, refused: error instanceof KeyRefused },
			),
		);
		this.core.on("modes", () => void this.modes());
		this.core.on("heard", ({ id }) => this.done(Number(id)));
		this.core.on("dropped", (text) => this.keep(text));
		this.core.on("turn", ({ text, cut }) => this.turn(text, cut));
		this.engines = new Engines(session, (engine, engineVoices) => {
			const chosen = localStorage.getItem(ENGINE_VOICE);
			this.set({
				engine,
				engineVoices,
				engineVoice:
					chosen !== null && engineVoices.includes(chosen)
						? chosen
						: (engineVoices[0] ?? null),
			});
			this.arm();
		});
		if (speaker) this.started = session.log.at(-1)?.n ?? 0;
		this.arm();
		this.unsubscribe = session.subscribe({
			entry: (entry) => {
				if (entry.type.startsWith(NAMES))
					void this.core.set({ names: this.names() });
				if (entry.n > this.started && this.armed && this.wantedEntry(entry))
					this.read(entry);
			},
		});
		const notice = (fact: Fact) => () => this.core.notice(fact);
		const engines = this.engines;
		this.activity = new Activity(session, name, (other) => engines.has(other), {
			read: notice("read"),
			message: notice("message"),
			other: notice("other"),
			joined: notice("joined"),
			left: notice("left"),
			progress: (progress) => {
				this.trace.event("progress", { progress });
				this.set({ progress });
				if (progress === "sent") this.core.notice("sent");
			},
		});
		void this.modes();
	}

	/** The core's state with the page's own. */
	private merged(): VoiceState {
		const core = this.core.state;
		return {
			...core,
			...this.own,
			reading: core.reading === null ? null : Number(core.reading),
		};
	}

	/** Starts the page's output, which the core plays through, and which the
	 * cues need: as the speaker or the microphone first comes on, since it
	 * starts the page's audio. */
	private sound(): void {
		if (this.output !== null) return;
		const output = new Output({
			play: (out, rate, played) => this.core.play(out, rate, played),
			dropped: (samples) => this.core.unplay(samples),
			short: (short) => this.trace.event("short", { samples: short }),
		});
		this.output = output;
		this.core.on("flush", () => output.flush());
	}

	private names(): Names {
		const entry = this.session.log.findLast((e) => e.type.startsWith(NAMES));
		return names(entry?.text);
	}

	/** Whether an entry is one the speaker reads: an agent's message. */
	private wantedEntry(entry: Entry): entry is Entry & { text: string } {
		return entry.from !== this.name && agent(entry.from) && spoken(entry);
	}

	/** Has the core read an entry, with its agent's own voice, by its place
	 * among the `speakers`. */
	private read(entry: Entry & { text: string }): void {
		const agents = speakers(this.session.log).filter((a) => a !== this.name);
		const n = agents.indexOf(entry.from);
		this.core.speak({
			id: String(entry.n),
			text: entry.text,
			voice: n < 0 ? agents.length : n,
		});
	}

	/** Done with every message up to `n`: read to its end, or dropped. */
	private done(n: number): void {
		if (n > Number(sessionStorage.getItem(this.readKey) ?? 0))
			sessionStorage.setItem(this.readKey, String(n));
	}

	/** Turns the cues on or off. */
	setSounds(sounds: boolean): void {
		localStorage.setItem(SOUNDS, sounds ? "on" : "off");
		void this.core.set({ sounds });
	}

	/** For React's `useSyncExternalStore`. */
	watch = (watcher: () => void): (() => void) => {
		this.watchers.add(watcher);
		return () => this.watchers.delete(watcher);
	};

	/** How loud the speaker sounds now, from 0 to 1: read it as often as
	 * needed, since it changes too fast for `state`. */
	speakerLevel(): number {
		return this.core.speakerLevel();
	}

	/** Call it from a click, since it starts the page's audio. While
	 * listening waits, it only keeps whether the person wants it. */
	async setListener(on: boolean): Promise<void> {
		if (this.standing) {
			this.wanted = on;
			this.keepModes();
			return;
		}
		await this.core.set({ listener: on });
		// Listening came to wait while the microphone opened.
		if (on && this.standing) await this.core.set({ listener: false });
	}

	/** Has listening wait, or ends the wait: waiting closes the microphone,
	 * keeping the words in progress in the draft, and the end of the wait
	 * opens it again if the person wants it on. */
	async standby(on: boolean): Promise<void> {
		if (on === this.standing) return;
		this.standing = on;
		this.trace.event("standby", { on });
		if (on) {
			this.wanted = this.state.listener || this.state.switching === "listener";
			if (this.state.listener) await this.core.set({ listener: false });
		} else if (this.wanted) {
			this.wanted = false;
			await this.setListener(true);
		}
	}

	/** Sets the languages the person speaks. Listening hears them from its
	 * next start, at once while nothing is being heard. */
	async setLanguages(languages: string[]): Promise<void> {
		this.trace.event("languages", { languages });
		this.core.notice("press");
		localStorage.setItem(LANGUAGES, JSON.stringify(languages));
		this.set({ languages });
		if (this.own.tier === "elevenlabs") await this.reopen();
	}

	/** Chooses where transcription and speech synthesis run. Listening
	 * switches at its next start, at once while nothing is being heard; reading
	 * aloud at once. */
	async setTier(tier: Tier): Promise<void> {
		if (this.own.tier === tier) return;
		this.trace.event("tier", { tier });
		this.core.notice("press");
		chooseTier(tier);
		this.set({ tier, error: null, refused: false });
		await this.modes();
		this.rearm();
		await this.reopen();
	}

	/** Chooses the engine's voice the agent speaks with, from its next
	 * sentence on. */
	setEngineVoice(engineVoice: string): void {
		if (engineVoice === this.own.engineVoice) return;
		this.trace.event("engineVoice", { voice: engineVoice });
		this.core.notice("press");
		localStorage.setItem(ENGINE_VOICE, engineVoice);
		this.set({ engineVoice });
	}

	/** Gives the ElevenLabs key, or takes it away, with the entry that
	 * brought it, if one did: what the others sent after it is read once
	 * ElevenLabs can speak. */
	async setKey(key: string | null, after?: number): Promise<void> {
		if (key === this.key) return;
		this.key = key;
		if (this.own.tier !== "elevenlabs") return;
		this.set({ error: null, refused: false });
		this.rearm(after ?? this.session.log.at(-1)?.n ?? 0);
		await this.reopen();
	}

	/** Has the core speak with the tier anew. */
	private rearm(after?: number): void {
		if (this.armed) void this.core.set({ synthesize: null });
		this.armed = false;
		this.arm(after);
	}

	/** Has the core, while the speaker is on, speak with the tier once it
	 * can, and read what the others sent from then on: after the latest
	 * engine's offer, or after entry `after` for a key. */
	private arm(after = 0): void {
		const local = this.own.tier === "local";
		// The engine's presence as its state, which the engines set as they
		// are made, before `this.engines` is.
		const ready = local ? this.own.engine : this.key !== null;
		if (ready !== this.own.ready) this.set({ ready });
		// The engines tell their first state as they are made: the speaker
		// is armed once they are.
		if (this.engines === undefined || ready === this.armed) return;
		this.armed = ready;
		void this.core.set({
			synthesize: ready ? () => this.synthesizer() : null,
		});
		if (ready && this.core.state.speaker)
			this.backlog(local ? this.engines.offer : after);
	}

	/**
	 * Reads at once the messages after entry `after`, from which on the tier
	 * could speak, except those this tab already read, heard or dropped; of
	 * those from before the speaker came on, only the ones that arrived just
	 * before, as during a reload. None from further back: the person may have
	 * heard or read them, and can have the last read again.
	 */
	private backlog(after: number): void {
		const since = Number(sessionStorage.getItem(this.readKey) ?? 0);
		const recent = Date.now() - RECENT * 1000;
		for (const entry of this.session.log)
			if (
				entry.n > Math.max(after, since) &&
				(entry.n > this.started || Date.parse(entry.time) > recent) &&
				this.wantedEntry(entry)
			)
				this.read(entry);
	}

	/** Opens listening again, for what it hears with to change. */
	private async reopen(): Promise<void> {
		await this.core.set({ transcribe: (heard) => this.transcribe(heard) });
	}

	/** Call it from a click, since it starts the page's audio. */
	async setSpeaker(on: boolean): Promise<void> {
		if (on === this.state.speaker || this.state.switching) return;
		if (on) {
			this.sound();
			this.started = this.session.log.at(-1)?.n ?? 0;
		}
		await this.core.set({ speaker: on });
		if (on && this.armed)
			this.backlog(this.own.tier === "local" ? this.engines.offer : 0);
	}

	/** Whether turns end by themselves: only what happens at the end of the
	 * next one changes, so a draft already there waits to be sent. */
	setAutoEnd(autoEnd: boolean): void {
		localStorage.setItem(AUTO_END, String(autoEnd));
		void this.core.set({ autoEnd });
	}

	/** Brings back the draft last deleted, ahead of what was said since. */
	undo(): void {
		this.core.undo();
	}

	/** Sends the draft, with what is still being heard once it is, dropping
	 * what was not heard of the agent's messages unless `interrupt` is off. */
	send(interrupt = true): void {
		this.core.send(interrupt);
	}

	/** A turn the person ended: what they heard of the messages they cut in
	 * on goes ahead of what they said, so that the agent has the turn as one
	 * entry. */
	private turn(text: string, cut: Heard[]): void {
		this.keep(text);
		const trace = this.trace.take();
		const marks = cut.map(({ id, text }) =>
			text
				? `[cut in on ${id} after "${text.replace(/\s+/g, " ")}"]`
				: `[cut in before ${id}]`,
		);
		// The message goes first, so that the trace's audio, which takes a
		// while to upload, holds it back from the agent no longer.
		this.queue(async () => {
			await this.session.send([...marks, text].join(" "), {
				type: "text/plain",
			});
			await this.shareTrace(trace);
		});
	}

	/** Sends the words that didn't count, as the person's: with the draft
	 * when turns end by hand, else at once, and the speaker reads on. */
	sendMissed(): void {
		this.core.sendMissed();
	}

	/** Drops the draft, with what is still being heard once it is, and the
	 * speaker reads on. */
	clear(): void {
		this.core.clear();
	}

	/** The person's edit of the draft. */
	setDraft(draft: string): void {
		this.core.edit(draft);
	}

	/** Copies the last transcript, sent or dropped. */
	async copyLast(): Promise<void> {
		if (!this.own.last) return;
		await navigator.clipboard.writeText(this.own.last);
		this.core.notice("press");
	}

	/** What the page kept of its trace and of the audio it heard, as a
	 * recording such as `just record` keeps, for the person to download and
	 * hand on themselves: `audio.wav` and `session.json` in a folder, zipped.
	 * The session's link, keys and secrets stay out. */
	async download(): Promise<{ name: string; blob: Blob }> {
		this.trace.event("download");
		const { events, audio } = this.trace.snapshot();
		const heard = audio.length > 0 ? recording(audio) : null;
		const messages = this.session.log.filter(
			({ type }) =>
				!/^application\/vnd\.polylogue\.(key|secret)/.test(type) &&
				!type.startsWith(TRACE) &&
				!type.startsWith("audio/"),
		);
		const session = {
			audioStart: heard && new Date(heard.start).toISOString(),
			messages,
			trace: events,
		};
		const name = `voice-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}`;
		const blob = await zip({
			...(heard && { [`${name}/audio.wav`]: heard.wav }),
			[`${name}/session.json`]: new Blob([JSON.stringify(session, null, 1)], {
				type: "application/json",
			}),
		});
		return { name: `${name}.zip`, blob };
	}

	/** Shares the page's trace with the session, at once what it kept so far,
	 * or stops. */
	share(on: boolean): void {
		this.trace.share(on);
		this.core.notice("press");
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

	/** The ElevenLabs key, which a missing one refuses. */
	private elevenlabs(): string {
		if (this.key === null) throw new KeyRefused("ElevenLabs needs your key.");
		return this.key;
	}

	private async transcribe(heard: Transcript): Promise<Transcriber> {
		if (this.own.tier === "local")
			return new LocalTranscriber(this.engines, heard);
		return Scribe.open(this.elevenlabs(), heard, this.own.languages);
	}

	private synthesizer(): Synthesizer {
		if (this.own.tier === "local")
			return new LocalSynthesizer(this.engines, () =>
				voiceOrder(this.own.engineVoice, this.own.engineVoices),
			);
		return new Speech(this.elevenlabs());
	}

	close(): void {
		this.unsubscribe();
		this.unwatchAudio();
		this.engines.close();
		this.activity.close();
		this.core.close();
		this.output?.close();
		holdAudioSession(false);
	}

	/** Play and pause from the system's media controls, as a headphone tap
	 * on a call: sends a draft, else mutes or unmutes. */
	mediaToggle = (): void => {
		const { draft, hearing } = this.state;
		if (draft || hearing) this.send();
		else void this.setListener(!(this.state.listener || this.wanted));
	};

	/** Holds the system's audio and media controls while voice is in use,
	 * and tells the others the modes, where they changed. */
	private modes(): Promise<void> {
		const { listener, speaker } = this.core.state;
		holdAudioSession(listener || speaker);
		holdMedia(listener || speaker, { toggle: this.mediaToggle });
		this.keepModes();
		const modes: Modes = { listener, speaker, tier: this.own.tier };
		const told = JSON.stringify(modes);
		if (told === this.told) return Promise.resolve();
		this.told = told;
		this.trace.event("modes", modes);
		return this.queue(() => this.session.send(told, { type: MODES }));
	}

	/** Keeps the modes for the tab, listening as the person wants it, so
	 * that a reload keeps them. */
	private keepModes(): void {
		const { listener, speaker } = this.core.state;
		sessionStorage.setItem(
			this.modesKey,
			JSON.stringify({ listener: listener || this.wanted, speaker }),
		);
	}

	private queue(send: () => Promise<unknown>): Promise<void> {
		const sent = this.sent.then(send);
		this.sent = sent.catch(() => {});
		return sent.then(
			() => {},
			(error: Error) => {
				this.core.notice("problem");
				this.set({
					error: error.message,
					refused: error instanceof KeyRefused,
				});
			},
		);
	}

	private set(change: Partial<VoiceState>): void {
		this.own = { ...this.own, ...change };
		// Before the core is made, only the page's own state is set.
		if (this.core === undefined) return;
		this.state = this.merged();
		for (const watcher of this.watchers) watcher();
	}
}
