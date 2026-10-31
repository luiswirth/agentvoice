// Voice as a whole: the listener and the speaker, each on or off on its own,
// and ending turns automatically as a switch of its own. Both on is a
// conversation, the speaker alone spoken answers, the listener alone
// dictation. What the person says gathers into a draft, which goes out as
// one chat message: at a segment's end if turns end automatically, else
// when the person sends it. Nothing the person says is lost: every
// transcript, sent or dropped, is kept in this browser, the last to copy.
// Words take the floor, pausing the speaker, and a message they end in
// drops what was not heard of the agent's: any voice's words while the agent
// named none, only a named voice's once it named any. The voice the speaker
// plays is its own, heard back as echo, which never takes the floor and is
// never sent. While the speaker plays, words take the floor only once their
// voice is known, and only a few words or a word to stop, so that the speaker
// reads on over a "mhm". Few words that only signal listening, a
// backchannel, are no turn and are not sent; other few words are. Words that
// didn't count, as its echo, too quiet or such a backchannel while it
// played, show for a while, to send. The listener only perceives, and this decides. What happens is heard
// as short cues, so that voice seems responsive while nothing is said.
// Ending turns only decides whether a turn goes out by itself: the listener
// only ever listens or stops, and with turns ended by hand what is said
// gathers in the draft until the person sends it. Transcription and speech synthesis run on
// ElevenLabs or on an engine in the session, the tier the person chooses.
import { Activity, type Progress } from "./activity.ts";
import { holdAudioSession } from "./audio.ts";
import { KeyRefused, Scribe, Speech } from "./elevenlabs.ts";
import type { Heard, Synthesizer, Tier, Transcriber } from "./engines.ts";
import { Listener, type Segment } from "./listener.ts";
import { Engines, LocalSynthesizer, LocalTranscriber } from "./local.ts";
import { holdMedia } from "./media.ts";
import {
	MODES,
	type Modes,
	NAMES,
	type Names,
	names,
	type Session,
	spoken,
} from "./protocol.ts";
import { type Cue, onPlay, play, setSounds, soundsOn } from "./sounds.ts";
import { Speaker } from "./speaker.ts";
import { TRACE, Trace } from "./trace.ts";

export type VoiceState = Modes & {
	/** Whether a turn ends by itself, after a pause. Kept in this browser. */
	autoEnd: boolean;
	/** The draft the person last deleted, to bring back, until they send or
	 * say more. */
	dropped: string | null;
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
	/** Words heard last that didn't count, as the speaker's echo, too quiet,
	 * or a backchannel while it played, for the person to send if they were
	 * theirs, or meant as a turn. */
	missed: { text: string; why: "echo" | "quiet" | "backchannel" } | null;
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
};

const TIER = "voice-tier";

/** Where transcription and speech synthesis run, as last chosen in this
 * browser: local, until the person chooses otherwise. */
export function chosenTier(): Tier {
	return localStorage.getItem(TIER) === "elevenlabs" ? "elevenlabs" : "local";
}

export function chooseTier(tier: Tier): void {
	localStorage.setItem(TIER, tier);
}

const ENGINE_VOICE = "voice-engine-voice";

/** The state that shows `error`. */
function failure(error: Error): Pick<VoiceState, "error" | "refused"> {
	play("problem");
	return { error: error.message, refused: error instanceof KeyRefused };
}

/** The pauses between the cues that the agent is still working, in seconds:
 * close at first, when an answer may still come any moment, then sparse,
 * the last repeating. */
const WORKING = [3, 5, 8, 12, 20];

/** How long after the agent read the person's message, in milliseconds,
 * its cue plays if it hasn't answered by then. */
const READ = 1000;

/** How soon after the speaker finished a message, in seconds, the next one
 * read counts as following it. */
const NEXT = 4;

const TRANSCRIPTS = "voice-transcripts";
const LANGUAGES = "voice-languages";
const AUTO_END = "voice-auto-end";

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

/** The words of a text, lower case, without punctuation. */
function wordsOf(text: string): string[] {
	return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function transcripts(): string[] {
	try {
		return JSON.parse(localStorage.getItem(TRANSCRIPTS) ?? "[]") as string[];
	} catch {
		return [];
	}
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
	private listener: Listener | null = null;
	private speaker: Speaker | null = null;
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
	/** The cue that the agent read the person's message, while it waits. */
	private readCue: ReturnType<typeof setTimeout> | undefined;
	private missedClear: ReturnType<typeof setTimeout> | undefined;
	/** When the speaker last finished a message, by `performance.now()`. */
	private readEnded = Number.NEGATIVE_INFINITY;
	state: VoiceState = {
		listener: false,
		speaker: false,
		autoEnd: localStorage.getItem(AUTO_END) !== "false",
		dropped: null,
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
		missed: null,
		error: null,
		refused: false,
		tier: chosenTier(),
		engine: false,
		engineVoices: [],
		engineVoice: null,
		ready: false,
	};

	/** `name` is the person's in the session, `key` their ElevenLabs key,
	 * which only what runs on ElevenLabs needs, and `setKey` gives later. */
	constructor(session: Session, name: string, key: string | null) {
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
		this.arm();
		this.unsubscribe = session.subscribe({
			entry: (entry) => {
				message();
				if (entry.type.startsWith(NAMES)) {
					named();
					this.trace.event("names", this.state.names);
				}
			},
		});
		onPlay((cue) => this.trace.event("cue", { cue }));
		this.activity = new Activity(session, name, {
			// An agent often reads the person's message only right before it
			// answers, so the cue waits a second, and plays only if the agent
			// is still working by then.
			read: () => {
				clearTimeout(this.readCue);
				this.readCue = setTimeout(
					() => play("read"),
					Math.max(READ, this.sentAt + READ - performance.now()),
				);
			},
			// A message read aloud now is heard as it is read, so a cue would
			// only come before the voice: it sounds only for one that waits,
			// while the person talks or reading aloud is paused, or isn't read.
			message: () => {
				const waits =
					this.state.held ||
					this.state.hearing !== "" ||
					this.state.voice !== undefined;
				if (!this.state.speaker || waits) play("message");
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
				else clearTimeout(this.readCue);
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
			// Words in progress still go to the draft, unsent: the microphone
			// hears nothing more, and the listener closes once they are in.
			if (this.finishing("keep")) this.stopping = true;
			else this.closeListener();
			this.set({ listener: false, level: 0 });
			this.cue("unlisten");
			return this.modes();
		}
		if (this.stopping) {
			// Still finishing: it listens on, and the words go in as they would.
			this.stopping = false;
			this.set({ listener: true, error: null });
			this.cue("listen");
			return this.modes();
		}
		this.set({ switching: "listener", error: null, refused: false });
		this.words = false;
		this.floor = false;
		this.few = false;
		this.heard = "";
		this.known = false;
		this.played = false;
		try {
			this.listener = await Listener.open(
				(heard) => this.transcribe(heard),
				{
					// The voice gets quieter at any speech, and stops only at
					// words, so that a cough or a noise stops nothing.
					voiced: (voiced) => this.speaker?.duck(voiced),
					speaking: () => {
						this.trace.event("speaking", { reading: this.state.reading });
						this.words = true;
						this.claim();
					},
					voice: (number, played) => {
						this.known = true;
						this.played = played;
						// The speaker's echo is no one speaking.
						const voice = played ? undefined : number;
						if (voice !== this.state.voice) this.set({ voice });
						this.show();
						this.claim();
					},
					partial: (heard) => {
						this.heard = heard;
						this.show();
						this.claim();
					},
					segment: (segment) => this.heardSegment(segment),
					audio: (pcm) => this.trace.hear(pcm),
					level: (level) => this.set({ level }),
					trace: (event, data) => this.trace.event(event, data),
					failed: (error) => {
						this.trace.event("failed", { error: error.message });
						this.listener = null;
						this.stopping = false;
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
				() => this.speaker?.playing ?? false,
				() => !this.stopping,
			);
			this.set({ listener: true, switching: null });
			this.cue("listen");
			await this.modes();
		} catch (error) {
			this.set({ switching: null, ...failure(error as Error) });
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
		this.trace.event(
			"partial",
			kept === 0
				? { text: hearing }
				: kept === last.length
					? { added: hearing.slice(kept) }
					: { kept, added: hearing.slice(kept) },
		);
		this.set({ hearing });
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
		if (echo.length > 0) this.trace.event("echo", { text: words(echo) });
		const backchannel =
			this.few &&
			!this.floor &&
			this.state.autoEnd &&
			wordsOf(words(theirs)).every((word) => BACKCHANNEL.has(word));
		const missed: VoiceState["missed"] = !loud
			? { text: words(runs), why: "quiet" }
			: theirs.length === 0
				? { text: words(echo), why: "echo" }
				: backchannel
					? { text: words(theirs), why: "backchannel" }
					: null;
		if (missed?.text) {
			this.trace.event("missed", missed);
			clearTimeout(this.missedClear);
			this.set({ missed });
			this.missedClear = setTimeout(
				() => this.set({ missed: null }),
				MISSED * 1000,
			);
		}
		const text = loud && !backchannel ? (this.listener?.tag(theirs) ?? "") : "";
		this.trace.event("segment", { text });
		if (text) this.set({ missed: null });
		this.segment(text);
	}

	/** Sets the languages the person speaks. Listening hears them from its
	 * next start, at once while nothing is being heard. */
	async setLanguages(languages: string[]): Promise<void> {
		this.trace.event("languages", { languages });
		play("press");
		localStorage.setItem(LANGUAGES, JSON.stringify(languages));
		this.set({ languages });
		if (this.state.tier === "elevenlabs") await this.reopen();
	}

	/** Chooses where transcription and speech synthesis run. Listening
	 * switches at its next start, at once while nothing is being heard; reading
	 * aloud at once. */
	async setTier(tier: Tier): Promise<void> {
		if (this.state.tier === tier) return;
		this.trace.event("tier", { tier });
		play("press");
		chooseTier(tier);
		this.set({ tier, error: null, refused: false });
		await this.modes();
		this.speaker?.use(null);
		this.arm();
		await this.reopen();
	}

	/** Chooses the engine's voice the agent speaks with, from its next
	 * sentence on. */
	setEngineVoice(engineVoice: string): void {
		if (engineVoice === this.state.engineVoice) return;
		this.trace.event("engineVoice", { voice: engineVoice });
		play("press");
		localStorage.setItem(ENGINE_VOICE, engineVoice);
		this.set({ engineVoice });
	}

	/** Gives the ElevenLabs key, or takes it away, with the entry that
	 * brought it, if one did: what the others sent after it is read once
	 * ElevenLabs can speak. */
	async setKey(key: string | null, after?: number): Promise<void> {
		if (key === this.key) return;
		this.key = key;
		if (this.state.tier !== "elevenlabs") return;
		this.set({ error: null, refused: false });
		this.speaker?.use(null);
		this.arm(after ?? this.session.log.at(-1)?.n ?? 0);
		await this.reopen();
	}

	/** Has the speaker, if on, speak with the tier once it can, and read
	 * what the others sent from then on: after the latest engine's offer, or
	 * after entry `after` for a key. */
	private arm(after = 0): void {
		const local = this.state.tier === "local";
		// The engine's presence as its state, which the engines set as they
		// are made, before `this.engines` is.
		const ready = local ? this.state.engine : this.key !== null;
		if (ready !== this.state.ready) this.set({ ready });
		const speaker = this.speaker;
		if (!speaker || speaker.ready === ready) return;
		speaker.use(
			ready ? this.synthesizer() : null,
			local ? this.engines.offer : after,
		);
	}

	/** Opens listening again, if it is on and nothing is being heard, for
	 * what it hears with to change. */
	private async reopen(): Promise<void> {
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
			const speaker = new Speaker(this.session, this.name);
			speaker.changed = (reading) => {
				this.trace.event("reading", { n: reading });
				// A message read right after another, so that the break
				// between the two is heard.
				const before = this.state.reading;
				const next =
					reading !== null &&
					(before !== null || performance.now() - this.readEnded < NEXT * 1000);
				if (next) play("next");
				if (reading === null && before !== null)
					this.readEnded = performance.now();
				this.set({ reading });
			};
			speaker.played = (samples) => this.listener?.played(samples);
			speaker.failed = (error) => {
				this.trace.event("failed", { error: error.message });
				this.set(failure(error));
			};
			this.speaker = speaker;
			this.arm();
		} else {
			this.speaker?.close();
			this.speaker = null;
		}
		this.set({ speaker: on, reading: null, held: false });
		this.cue(on ? "speak" : "unspeak");
		await this.modes();
	}

	/** Whether turns end by themselves: only what happens at the end of the
	 * next one changes, so a draft already there waits to be sent. */
	setAutoEnd(autoEnd: boolean): void {
		if (autoEnd === this.state.autoEnd) return;
		this.trace.event("autoEnd", { on: autoEnd });
		play("press");
		localStorage.setItem(AUTO_END, String(autoEnd));
		this.set({ autoEnd });
	}

	/** Brings back the draft last deleted, ahead of what was said since. */
	undo(): void {
		const dropped = this.state.dropped;
		if (!dropped) return;
		this.trace.event("undo", { text: dropped });
		play("press");
		this.set({ dropped: null, draft: join(dropped, this.state.draft) });
	}

	private closeListener(): void {
		this.stopping = false;
		this.listener?.close();
		this.listener = null;
		this.set({ hearing: "", level: 0, voice: undefined });
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
		this.trace.event("floor", { voice, reading: this.state.reading });
		this.speaker?.pause();
	}

	/** Sends the draft, with what is still being heard once it is, dropping
	 * what was not heard of the agent's messages unless `interrupt` is off. */
	send(interrupt = true): void {
		if (this.finishing("send")) return;
		const text = join(this.state.draft, this.state.hearing);
		this.set({ draft: "", hearing: "", dropped: null });
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
		// The message goes first, so that the trace's audio, which takes a
		// while to upload, holds it back from the agent no longer.
		// What the person heard of the messages they cut in on goes ahead of
		// what they said, so that the agent has the turn as one entry.
		const cut = heard.map(({ n, text }) =>
			text
				? `[cut in on ${n} after "${text.replace(/\s+/g, " ")}"]`
				: `[cut in before ${n}]`,
		);
		this.queue(async () => {
			await this.session.send([...cut, text].join(" "), {
				type: "text/plain",
			});
			await this.shareTrace(trace);
		});
	}

	/** Sends the words that didn't count, as the person's: with the draft
	 * when turns end by hand, else at once, and the speaker reads on. */
	sendMissed(): void {
		const missed = this.state.missed;
		if (!missed) return;
		clearTimeout(this.missedClear);
		this.trace.event("send missed", missed);
		this.set({ missed: null, draft: join(this.state.draft, missed.text) });
		if (this.state.autoEnd && !this.state.hearing) this.send(false);
	}

	/** Drops the draft, with what is still being heard once it is, and the
	 * speaker reads on. */
	clear(): void {
		if (this.finishing("drop")) return;
		const text = join(this.state.draft, this.state.hearing);
		this.trace.event("drop", { text });
		if (text) {
			this.keep(text);
			this.set({ dropped: text });
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
	private finishing(ending: "send" | "drop" | "keep"): boolean {
		if (!this.state.hearing || !this.listener?.finish()) return false;
		// Sending or dropping, once asked for, is not undone by stopping.
		if (ending !== "keep" || !this.ending) this.ending = ending;
		return true;
	}

	/** Skips the message being read. */
	skip(): void {
		this.trace.event("skip");
		play("press");
		this.speaker?.skip();
	}

	/** The ElevenLabs key, which a missing one refuses. */
	private elevenlabs(): string {
		if (this.key === null) throw new KeyRefused("ElevenLabs needs your key.");
		return this.key;
	}

	private async transcribe(heard: Heard): Promise<Transcriber> {
		if (this.state.tier === "local")
			return new LocalTranscriber(this.engines, heard);
		return Scribe.open(this.elevenlabs(), heard, this.state.languages);
	}

	private synthesizer(): Synthesizer {
		if (this.state.tier === "local")
			return new LocalSynthesizer(
				this.engines,
				() => this.state.engineVoice ?? undefined,
			);
		return new Speech(this.elevenlabs());
	}

	close(): void {
		this.unsubscribe();
		this.engines.close();
		this.activity.close();
		clearTimeout(this.working);
		clearTimeout(this.readCue);
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
		this.few = false;
		this.heard = "";
		this.known = false;
		this.played = false;
		this.set({
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

	/** Play and pause from the system's media controls: sends a draft, else
	 * pauses or resumes reading, else turns listening on or off. */
	mediaToggle = (): void => {
		const { draft, hearing } = this.state;
		if (draft || hearing) this.send();
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
		if (this.restoring) return Promise.resolve();
		sessionStorage.setItem(
			this.modesKey,
			JSON.stringify({ listener, speaker }),
		);
		const modes: Modes = { listener, speaker, tier: this.state.tier };
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
