// The ElevenLabs tier, reached straight from the host with the user's own key:
// Scribe v3 Live hears, Eleven v4 Turbo speaks. Nothing here touches an
// audio device.

import { Fingerprints } from "./fingerprints.ts";
import type {
	FromFingerprints,
	FromTurns,
	Port,
	ToFingerprints,
	ToTurns,
} from "./reflexes.ts";
import type { Store } from "./store.ts";
import {
	type Hearer,
	LISTEN_RATE,
	Offsets,
	type Perception,
	type Piece,
	type Said,
	SPEECH_RATE,
	type Synthesizer,
} from "./tier.ts";

const API = "https://api.elevenlabs.io/v1";
const SOCKETS = "wss://api.elevenlabs.io/v1";

/** Arthur, a library voice: "clear, engaging", an audiobook narrator. */
export const VOICE = "C1npRmjB19a6yNkEucvx";

/** Premade voices that sound apart, from the one before and from Arthur, for
 * the agents after the first: Alice, George, Sarah, Charlie, Lily, Brian and
 * Matilda. */
const APART = [
	"Xb7hH8MSUJpSbSDYk0k2",
	"JBFqnCBsd6RMkjVDRZzb",
	"EXAVITQu4vr4xnSDxMaL",
	"IKne3meq5aSn9XLyUdCD",
	"pFZP5JQG7iQjIQuC4Bku",
	"nPczCjzI2devNBz1zQrb",
	"XrExE9yKIg1WjnnlVkGX",
];

/** ElevenLabs refused the key itself, which another key fixes: it is
 * invalid, out of credits, or lacks a permission voice needs. */
export class KeyRefused extends Error {}

/** An error ElevenLabs gave as a `code` and a `message`, a `KeyRefused`
 * where the code is about the key. */
function refusal(code: string, message: string): Error {
	return /key|auth|quota|permission|credit|payment/i.test(code)
		? new KeyRefused(`ElevenLabs refused the key: ${message}`)
		: new Error(`ElevenLabs: ${message || code}`);
}

/** A single-use token, for a socket that takes no header from a browser. */
async function token(key: string, type: "realtime_scribe"): Promise<string> {
	const response = await fetch(`${API}/single-use-token/${type}`, {
		method: "POST",
		headers: { "xi-api-key": key },
	});
	if (!response.ok) {
		const text = await response.text();
		let detail: { status?: string; message?: string } = {};
		try {
			detail = JSON.parse(text).detail ?? {};
		} catch {}
		throw response.status === 401 || response.status === 403
			? new KeyRefused(`ElevenLabs refused the key: ${detail.message ?? text}`)
			: refusal(detail.status ?? "", detail.message ?? text);
	}
	return ((await response.json()) as { token: string }).token;
}

/** Throws a `KeyRefused` unless ElevenLabs takes `key` for listening, at no
 * cost: a token is free. */
export async function checkKey(key: string): Promise<void> {
	await token(key, "realtime_scribe");
}

function opened(socket: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("close", (event) => reject(closed(event)), {
			once: true,
		});
	});
}

/** Why a socket closed, as far as the browser tells: 1006 is a connection
 * lost with no close from the other side, which gives no reason. */
function closed({ code, reason }: CloseEvent): Error {
	return new Error(
		code === 1006
			? "The connection to ElevenLabs was lost."
			: `ElevenLabs closed the connection (${code}${reason ? `: ${reason}` : ""}).`,
	);
}

function base64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/** A chunk of audio, as Scribe takes it. */
function chunk(pcm: Int16Array): string {
	return JSON.stringify({
		message_type: "input_audio_chunk",
		audio_base_64: base64(
			new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
		),
		commit: false,
		sample_rate: LISTEN_RATE,
	});
}

function unbase64(text: string): Uint8Array {
	return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/** Scribe v3 Live's word, as it labels it: `speaker_0` and on, null while
 * it doesn't know whose it is yet. */
type Labeled = {
	text: string;
	start?: number | null;
	end?: number | null;
	speaker_id?: string | null;
};

/** When a segment ends, by Scribe's turn prediction, how likely it finds
 * that the person is done, and how long they have been silent, in seconds:
 * at once where it is `sure`, after `wait` where it is `likely`, and after
 * `longest` anyway, where their words trail off. Scribe's own commits on
 * its prediction wait for 0.9, which plain statements reach only after
 * about 3 s, and for no longer silence than 3 s, which cuts a turn a
 * person pauses in to think. */
const END = { sure: 0.8, likely: 0.5, wait: 3, longest: 6 };

/** How long a segment gets, in seconds. Scribe ends one on its own at
 * about 35 s, and the end of one longer than about 28 s, its own or asked
 * for, keeps only the words of its last few seconds, as measured 2026-11-25.
 * So a long segment is ended at a pause once it is `LONG` long, and at
 * `LONGEST` anyway, and its words go on into the next segment: such an end
 * is no turn's. */
const LONG = 15;
const LONGEST = 25;

/** How fast audio kept from a lost connection is sent again, against real
 * time: Scribe hears faster, but a commit ends only what it heard by then. */
const CATCH_UP = 2;

/** How long Scribe may stay silent while it is sent audio, in seconds,
 * before the connection counts as lost: it answers at least every second. */
const DEAF = 8;

/** The pauses between attempts to connect again, in seconds, the last repeating. */
const RECONNECT = [0.5, 1, 2, 4, 8];

/** How long the fingerprint may take to tell an echo, in seconds, before a
 * segment goes on without it. */
const ECHO_WAIT = 5;

/** Scribe v3 Live, left to detect the language, writes English with the
 * punctuation of Chinese, as "today？": each such mark after a Latin
 * letter, with its own mark. */
const MARKS: Record<string, string> = {
	"，": ",",
	"。": ".",
	"？": "?",
	"！": "!",
	"：": ":",
	"；": ";",
};
const LATIN_MARK = /(?<=[\p{Script=Latin}\p{N}])([，。？！：；])/gu;

/** How long before speech starts Scribe hears it, in seconds, so that a soft
 * start, which speech detection hears late, is kept; how much is kept for
 * it; and how long after speech stops it hears on while no words are in
 * progress. While words are, it hears on until their segment ends. */
const GATE = { preroll: 0.5, kept: 1, after: 1.5 };

/** Scribe closes a session that is sent no audio for about 15 s, so the
 * gate sends 10 ms of silence after every 5 s it keeps closed. */
const KEEPALIVE = 5 * LISTEN_RATE;
const ALIVE = new Int16Array(LISTEN_RATE / 100);

/** How long a voice's words go on, in seconds, before the fingerprint is
 * asked whether they are the speaker's echo, how often it is asked again,
 * and the longest it hears for it. */
const PROBE = { first: 0.75, every: 0.5, longest: 1.5 };

/** Where Scribe hears and fingerprints. */
export type Surroundings = {
	/** Speech detection, which gates what Scribe hears, so that silence is
	 * not paid for. */
	speech: Port<ToTurns, FromTurns>;
	/** The voice fingerprint, which tells the speaker's echo. */
	fingerprints: Port<ToFingerprints, FromFingerprints>;
	/** Where the voices heard are kept. */
	store: Store;
};

/** What goes to Scribe, in order: a chunk of the stream, from sample `at`,
 * or the end of a segment, asked for `why`. */
type Out = { pcm: Int16Array; at: number } | { commit: string };

/**
 * Scribe v3 Live's hearing, on its own turn prediction and its own speaker
 * labels: a segment ends as `END` judges it, and each word takes the voice
 * of its label. Scribe numbers the voices of one session, so a new session
 * numbers them anew: nothing maps one session's voices to another's. It
 * hears only from shortly before speech, as speech detection hears it, until
 * the segment it is in ends, so that silence is not paid for. The voice
 * fingerprint hears each label's words, and drops those of a label that
 * sounds like the speaker, as its echo.
 *
 * Nothing the person said is lost to the connection: what is sent is kept
 * until Scribe ended the segment it is in, and a connection lost, or one
 * that went silent, is opened again, with what was kept sent again first.
 * Only ElevenLabs refusing the key, or speech detection failing, stops
 * hearing.
 */
export class Scribe implements Hearer {
	/** Samples queued since the last commit: Scribe refuses a commit of under 0.3 s, and closes. */
	private uncommitted = 0;
	/** How long the segment Scribe ended last is, in samples. */
	private length = 0;
	/** Samples written to the socket since the last commit written. */
	private written = 0;
	/** The words of segments ended for their length, which go on into the next. */
	private held: Said[] = [];
	/** Which label each merged label became. */
	private merged = new Map<string, string>();
	/** How sure Scribe is that the turn is done. */
	private probability = 0;
	/** Why the segment in progress is being ended, once a commit is queued. */
	private asked: string | null = null;
	/** Where its words last changed, in seconds of what was sent. */
	private changed = 0;
	/** The words of the segment in progress, as letters, to tell a change. */
	private letters = "";
	/** Where what Scribe was sent lies in the stream, for the session open
	 * now, and up to which sample of the stream it was sent. */
	private offsets = new Offsets();
	private cursor = 0;
	/** What is still to go to Scribe, in order, and what went to the session
	 * open now and is kept until Scribe ends its segment. */
	private readonly queue: Out[] = [];
	private readonly unconfirmed: Out[] = [];
	/** When the session open now opened, by `performance.now()`, and how much
	 * audio it was written since, in samples, for catching up no faster than
	 * `CATCH_UP`. */
	private since = 0;
	private sentSince = 0;
	/** When Scribe last answered, and samples written since. */
	private answered = 0;
	private unanswered = 0;
	private pumping: ReturnType<typeof setTimeout> | undefined;
	/** Samples kept from Scribe since the last sent. */
	private quiet = 0;
	/** Whether the gate is open, whether speech detection hears speech, and
	 * since when, in seconds of the stream, it hears none. */
	private open = false;
	private voiced = false;
	private silent = 0;
	/** Why speech detection failed, or the key was refused, which stops
	 * hearing: an open gate would send all the person's audio, which the page
	 * says it doesn't. */
	private broken: Error | null = null;
	private stopped = false;
	private closing = false;
	/** The chunks speech detection has not heard yet, in order. */
	private readonly unheard: Int16Array[] = [];
	/** Seconds of the stream speech detection heard. */
	private passed = 0;
	/** What speech detection heard last while the gate was closed, for Scribe
	 * to hear once speech starts. */
	private kept: { pcm: Int16Array; at: number }[] = [];
	/** Whether each voice, by its number, is the speaker's echo, as the
	 * fingerprint last heard it; and the voice told last. */
	private echoes = new Map<number, boolean>();
	private told: string | null = null;
	/** Where the fingerprint was last asked about the voice heard now. */
	private probed: { voice: number; at: number } | null = null;
	/** The segments being fingerprinted, told in order. */
	private telling: Promise<void> = Promise.resolve();
	/** The session open now, null while one opens. */
	private socket: WebSocket | null = null;
	private readonly connect: () => Promise<WebSocket>;
	private readonly heard: Perception;
	private readonly speech: Port<ToTurns, FromTurns>;
	private readonly fingerprints: Fingerprints;

	private constructor(
		connect: () => Promise<WebSocket>,
		heard: Perception,
		{ speech, fingerprints, store }: Surroundings,
	) {
		this.connect = connect;
		this.heard = heard;
		this.speech = speech;
		this.fingerprints = new Fingerprints(fingerprints, store);
		speech.receive(
			(data) => this.detected(data),
			(error) => this.fail(error.message),
		);
	}

	/** `languages`: what the person speaks, most likely first, as BCP 47 tags
	 * or bare codes; Scribe hears only these, following the person from one
	 * to another, and detects the language where there are none. */
	static async open(
		key: string,
		heard: Perception,
		languages: readonly string[],
		surroundings: Surroundings,
	): Promise<Scribe> {
		const codes = languages.map(
			(tag) => tag.split("-")[0]?.toLowerCase() ?? "",
		);
		const [first, ...rest] = [...new Set(codes)].filter((code) => code !== "");
		const connect = async () => {
			const query = new URLSearchParams({
				model_id: "scribe_v3_live",
				token: await token(key, "realtime_scribe"),
				audio_format: `pcm_${LISTEN_RATE}`,
				commit_strategy: "manual",
				diarize: "true",
				// A partial at least every second, so that a silence is judged in time.
				keepalive_interval_ms: "1000",
			});
			if (first !== undefined) query.set("language_code", first);
			for (const code of rest) query.append("secondary_languages", code);
			if (rest.length > 0) query.set("multilang_mode", "true");
			const socket = new WebSocket(
				`${SOCKETS}/speech-to-text/realtime?${query}`,
			);
			await opened(socket);
			return socket;
		};
		const scribe = new Scribe(connect, heard, surroundings);
		try {
			scribe.attach(await connect());
		} catch (error) {
			scribe.close();
			throw error;
		}
		return scribe;
	}

	/** Takes `socket` as the session, and sends it what is queued. */
	private attach(socket: WebSocket): void {
		this.socket = socket;
		this.since = performance.now();
		this.sentSince = 0;
		this.answered = this.since;
		this.unanswered = 0;
		socket.addEventListener("message", ({ data }) => {
			if (socket !== this.socket) return;
			this.answered = performance.now();
			this.unanswered = 0;
			this.receive(JSON.parse(String(data)));
		});
		socket.addEventListener("close", (event) => {
			if (socket !== this.socket || this.closing) return;
			this.lost(closed(event).message);
		});
		this.pump();
	}

	/** The session was lost: what it was sent and Scribe didn't end yet goes
	 * again, ahead of what is queued, to a new session, which numbers its
	 * voices anew. */
	private lost(why: string): void {
		const socket = this.socket;
		if (socket === null || this.closing || this.broken) return;
		this.socket = null;
		clearTimeout(this.pumping);
		socket.close();
		this.heard.trace("scribe.lost", {
			why,
			again: this.unconfirmed.length,
			queued: this.queue.length,
		});
		this.queue.unshift(...this.unconfirmed.splice(0));
		this.offsets = new Offsets();
		this.cursor = 0;
		this.written = 0;
		this.letters = "";
		this.probability = 0;
		this.merged = new Map();
		this.echoes = new Map();
		this.told = null;
		this.probed = null;
		// The partials start over with what is sent again.
		this.heard.partial(this.held);
		void this.reconnect();
	}

	private async reconnect(): Promise<void> {
		for (let attempt = 0; !this.closing && !this.broken; attempt++) {
			const pause = RECONNECT[Math.min(attempt, RECONNECT.length - 1)] ?? 0;
			await new Promise<void>((r) => setTimeout(r, pause * 1000));
			if (this.closing || this.broken) return;
			try {
				const socket = await this.connect();
				if (this.closing || this.broken) {
					socket.close(1000);
					return;
				}
				this.heard.trace("scribe.connected", { attempt });
				this.attach(socket);
				return;
			} catch (error) {
				if (error instanceof KeyRefused) {
					this.refuse(error);
					return;
				}
				this.heard.trace("scribe.connecting", {
					attempt,
					error: (error as Error).message,
				});
			}
		}
	}

	/** ElevenLabs refused the key, which no new session fixes. */
	private refuse(error: Error): void {
		if (this.broken) return;
		this.broken = error;
		this.heard.failed(error);
	}

	private receive(message: Record<string, unknown>): void {
		switch (message.message_type) {
			case "partial_transcript": {
				const words = this.said(message);
				this.probability = Number(message.turn_probability ?? 0);
				this.probe(words);
				this.heard.partial(this.after(words));
				this.judge(String(message.text ?? ""));
				return;
			}
			// A segment ends with its labels, which come right after.
			case "committed_transcript":
				if (this.unconfirmed.some((out) => "commit" in out)) this.length = 0;
				else {
					this.length = this.written;
					this.written = 0;
				}
				return;
			case "diarized_transcript": {
				const words = this.after(this.said(message));
				// What was sent up to the commit is heard; without a commit of
				// ours, Scribe ended the segment on its own, with all sent so far.
				const at = this.unconfirmed.findIndex((out) => "commit" in out);
				const out = this.unconfirmed.splice(
					0,
					at < 0 ? this.unconfirmed.length : at + 1,
				);
				const asked = at < 0 ? null : (out.at(-1) as { commit: string }).commit;
				if (![...this.unconfirmed, ...this.queue].some((o) => "commit" in o))
					this.asked = null;
				if (
					asked === "long" ||
					(asked === null && this.length >= LONGEST * LISTEN_RATE)
				) {
					this.heard.trace("cut", { probability: this.probability, asked });
					this.held = words;
					// The words go on, so their silence does too.
					this.letters = lettersOf(words.map((word) => word.text).join(""));
					return;
				}
				this.letters = "";
				this.end(words, asked ?? "silence");
				return;
			}
			case "speakers_merged": {
				const from = String(message.from_speaker_id);
				const to = String(message.to_speaker_id);
				this.merged.set(from, to);
				this.heard.trace("voice.merged", { from, to });
				return;
			}
			default:
				if (message.error) {
					const error = refusal(
						String(message.message_type),
						String(message.error),
					);
					if (error instanceof KeyRefused) {
						this.refuse(error);
						this.socket?.close();
					} else this.lost(error.message);
				}
		}
	}

	/** The segment in progress ended, for `reason`, with `words`: they go on
	 * once the fingerprint told which voices are the speaker's echo. */
	private end(words: Said[], reason: string): void {
		this.heard.trace("turn.end", { reason, probability: this.probability });
		this.held = [];
		this.told = null;
		this.probed = null;
		this.probability = 0;
		// Without the speaker, there is no echo to wait for, and the
		// fingerprint only learns the voices.
		const timed = runs(words);
		const echoes = this.echo(words);
		const sounded = this.fingerprints.sounding(
			timed[0]?.from ?? 0,
			timed.at(-1)?.to ?? 0,
		);
		this.telling = this.telling.then(async () => {
			const played = sounded
				? await Promise.race([
						echoes,
						new Promise<Set<number>>((r) =>
							setTimeout(() => r(new Set()), ECHO_WAIT * 1000),
						),
					])
				: new Set<number>();
			this.heard.segment(
				words.map((word) => ({
					...word,
					played: word.voice !== null && played.has(word.voice),
				})),
			);
		});
	}

	/** The voices of a segment that are the speaker's echo: each by the
	 * longest run of its words, where the fingerprint can tell. */
	private async echo(words: Said[]): Promise<Set<number>> {
		const longest = new Map<number, { from: number; to: number }>();
		for (const run of runs(words)) {
			const best = longest.get(run.voice);
			if (!best || run.to - run.from > best.to - best.from)
				longest.set(run.voice, run);
		}
		const played = new Set<number>();
		const echoes = this.echoes;
		await Promise.all(
			[...longest].map(async ([voice, { from, to }]) => {
				const echo = await this.fingerprints.echo(from, to);
				this.heard.trace("voice", { voice, from, to, played: echo });
				if (echo === null) return;
				echoes.set(voice, echo);
				if (echo) played.add(voice);
			}),
		);
		return played;
	}

	/** Tells the voice heard now, once the fingerprint can tell whether it is
	 * the speaker's echo, asking it while that voice's words go on. */
	private probe(words: Said[]): void {
		const run = runs(words).at(-1);
		if (!run) return;
		const known = this.echoes.get(run.voice);
		if (known !== undefined) this.tell(run.voice, known);
		if (run.to - run.from < PROBE.first) return;
		if (
			this.probed?.voice === run.voice &&
			run.to - this.probed.at < PROBE.every
		)
			return;
		this.probed = { voice: run.voice, at: run.to };
		const from = Math.max(run.from, run.to - PROBE.longest);
		const echoes = this.echoes;
		void this.fingerprints.probe(from, run.to).then((echo) => {
			if (echo === null || echoes !== this.echoes) return;
			this.heard.trace("voice.now", { voice: run.voice, played: echo });
			echoes.set(run.voice, echo);
			this.tell(run.voice, echo);
		});
	}

	private tell(voice: number, played: boolean): void {
		const told = `${voice} ${played}`;
		if (told === this.told) return;
		this.told = told;
		this.heard.voice(voice, played);
	}

	/** Words after those held, if any. */
	private after(words: Said[]): Said[] {
		if (this.held.length === 0) return words;
		return [...this.held, { text: " ", voice: null }, ...words];
	}

	/** A message's words, timed in the stream, each with the voice of its
	 * label, or its text as one word where it has none. */
	private said(message: Record<string, unknown>): Said[] {
		const words = (message.words ?? []) as Labeled[];
		if (words.length === 0)
			return [{ text: latin(String(message.text ?? "")), voice: null }];
		return words.map((word, i) => {
			const text = latin(word.text, words[i + 1]?.text);
			const voice = this.number(word.speaker_id ?? null);
			if (word.start == null || word.end == null) return { text, voice };
			const { start, end } = this.offsets.place({
				text,
				start: word.start,
				end: word.end,
			});
			return { text, voice, start, end };
		});
	}

	/** The number of a label, after its merges: `speaker_0` is 1. */
	private number(label: string | null): number | null {
		let at = label;
		for (
			let next = at && this.merged.get(at);
			next;
			next = this.merged.get(next)
		)
			at = next;
		const n = Number(at?.match(/^speaker_(\d+)$/)?.[1] ?? Number.NaN);
		return Number.isNaN(n) ? null : n + 1;
	}

	/** The next 0.1 s of the person's audio, which speech detection hears
	 * first, and the fingerprint at once. */
	hear(pcm: Int16Array, sounding: boolean): void {
		if (this.broken !== null) {
			this.stop();
			return;
		}
		this.fingerprints.hear(pcm, sounding);
		this.unheard.push(pcm);
		const copy = pcm.slice();
		this.speech.post({ type: "audio", pcm: copy.buffer }, [copy.buffer]);
	}

	played(samples: Float32Array): void {
		this.fingerprints.played(samples);
	}

	/** What speech detection tells. */
	private detected(data: FromTurns): void {
		switch (data.type) {
			case "heard": {
				const pcm = this.unheard.shift();
				if (pcm) this.take(pcm);
				return;
			}
			case "speech":
				this.voiced = true;
				this.heard.voiced(true);
				if (!this.open) {
					this.open = true;
					this.heard.trace("gate", { open: true, at: data.at });
					for (const { pcm, at } of this.kept.splice(0))
						if (at + pcm.length / LISTEN_RATE > data.at - GATE.preroll)
							this.send(pcm, at);
						else this.skip(pcm.length);
				}
				return;
			case "silence":
				this.voiced = false;
				this.silent = data.at;
				this.heard.voiced(false);
				return;
			case "failed":
				this.fail(data.error);
				return;
		}
	}

	/** Speech detection failed: nothing more is sent, and hearing stops at
	 * the next audio, once the listener is there to tell. */
	private fail(error: string): void {
		if (this.broken !== null) return;
		this.heard.trace("gate.failed", { error });
		this.broken = new Error(`Speech detection failed: ${error}`);
		this.open = false;
		this.unheard.length = 0;
		this.kept = [];
	}

	private stop(): void {
		if (this.stopped || this.broken === null) return;
		this.stopped = true;
		this.heard.failed(this.broken);
	}

	/** Sends the chunk speech detection heard next, or keeps it while the
	 * gate is closed, and closes the gate once the speech is over. */
	private take(pcm: Int16Array): void {
		const at = this.passed;
		this.passed += pcm.length / LISTEN_RATE;
		if (this.open && !this.voiced) {
			const after = this.passed - this.silent;
			const over =
				(this.asked !== null && this.asked !== "long") ||
				(this.letters === "" && after >= GATE.after) ||
				after >= END.longest + GATE.after;
			if (over) {
				this.open = false;
				this.heard.trace("gate", { open: false });
			}
		}
		if (this.open) {
			this.send(pcm, at);
			// A long segment ends before Scribe ends it, at a pause if it can.
			if (
				this.asked === null &&
				(this.uncommitted >= LONGEST * LISTEN_RATE ||
					(this.uncommitted >= LONG * LISTEN_RATE && !this.voiced))
			)
				this.commit("long");
			return;
		}
		this.kept.push({ pcm, at });
		while ((this.kept[0]?.at ?? this.passed) < this.passed - GATE.kept)
			this.skip(this.kept.shift()?.pcm.length ?? 0);
	}

	/** Samples of the stream not sent: Scribe is sent a little silence now
	 * and then, so that it keeps the session open. */
	private skip(samples: number): void {
		this.quiet += samples;
		if (this.quiet < KEEPALIVE) return;
		this.quiet = 0;
		// Only while nothing waits: Scribe hears silence between the two anyway.
		if (this.socket?.readyState !== WebSocket.OPEN || this.queue.length > 0)
			return;
		this.socket.send(chunk(ALIVE));
		this.offsets.pad(ALIVE.length);
		this.written += ALIVE.length;
	}

	/** Queues the chunk from `at` seconds of the stream, for Scribe. */
	private send(pcm: Int16Array, at: number): void {
		this.quiet = 0;
		this.uncommitted += pcm.length;
		this.queue.push({ pcm, at: Math.round(at * LISTEN_RATE) });
		this.pump();
	}

	/** Writes what is queued to the session, no faster than `CATCH_UP`
	 * times real time, and keeps it until Scribe ends its segment. */
	private pump(): void {
		clearTimeout(this.pumping);
		const socket = this.socket;
		if (socket === null || socket.readyState !== WebSocket.OPEN) return;
		const now = performance.now();
		if (
			this.unanswered >= DEAF * LISTEN_RATE &&
			now - this.answered > DEAF * 1000
		) {
			this.lost("ElevenLabs stopped answering.");
			return;
		}
		while (this.queue.length > 0) {
			const ahead =
				this.sentSince / LISTEN_RATE - (CATCH_UP * (now - this.since)) / 1000;
			if (ahead > 1) {
				this.pumping = setTimeout(() => this.pump(), ahead * 500);
				return;
			}
			const out = this.queue.shift() as Out;
			this.unconfirmed.push(out);
			if ("commit" in out) {
				this.written = 0;
				socket.send(
					JSON.stringify({
						message_type: "input_audio_chunk",
						audio_base_64: "",
						commit: true,
						sample_rate: LISTEN_RATE,
					}),
				);
				continue;
			}
			if (out.at > this.cursor) this.offsets.skip(out.at - this.cursor);
			this.offsets.hear(out.pcm.length);
			this.cursor = out.at + out.pcm.length;
			this.written += out.pcm.length;
			this.sentSince += out.pcm.length;
			this.unanswered += out.pcm.length;
			socket.send(chunk(out.pcm));
		}
		// Checks again that Scribe answers, while audio waits for it.
		if (this.unanswered > 0)
			this.pumping = setTimeout(() => this.pump(), DEAF * 1000);
	}

	/** Seconds of audio sent. */
	private get sent(): number {
		return this.offsets.sent / LISTEN_RATE;
	}

	/** Ends the segment in progress where Scribe's turn prediction and the
	 * silence since its words last changed say the person is done. */
	private judge(text: string): void {
		// Words held from a long segment are the segment's too.
		// Words held from a long segment are the segment's too.
		const letters = lettersOf(
			[...this.held.map((word) => word.text), text].join(" "),
		);
		if (letters !== this.letters) {
			this.letters = letters;
			this.changed = this.sent;
		}
		if (letters === "" || (this.asked !== null && this.asked !== "long"))
			return;
		const silence = this.sent - this.changed;
		const p = this.probability;
		if (p >= END.sure) this.commit("turn");
		else if (silence >= END.wait && p >= END.likely) this.commit("wait");
		else if (silence >= END.longest) this.commit("silence");
	}

	/** Ends the segment in progress now, if it holds enough audio to, or
	 * what is held of it; whether its end is still to come. */
	finish(): boolean {
		if (this.commit("by hand")) return true;
		if (this.held.length === 0) return false;
		const words = this.held;
		this.unconfirmed.length = 0;
		this.end(words, "by hand");
		return true;
	}

	/** Ends the segment in progress for `why`, if it holds enough audio to;
	 * whether it will, once Scribe heard what was queued before. */
	private commit(why: string): boolean {
		if (this.asked !== null && this.asked !== "long") return true;
		if (this.asked === "long") {
			// The long one queued last ends the turn instead, as asked now.
			const last = [...this.unconfirmed, ...this.queue].findLast(
				(o) => "commit" in o,
			) as { commit: string } | undefined;
			if (last && this.uncommitted < (2 * LISTEN_RATE) / 5) {
				last.commit = why;
				this.asked = why;
				return true;
			}
		}
		if (this.uncommitted < (2 * LISTEN_RATE) / 5) return false;
		this.uncommitted = 0;
		this.asked = why;
		this.queue.push({ commit: why });
		this.pump();
		return true;
	}

	close(): void {
		this.closing = true;
		clearTimeout(this.pumping);
		this.socket?.close(1000);
		this.speech.close();
		this.fingerprints.close();
	}
}

/** How far a run of words is heard beyond its first and last word, in
 * seconds, for the fingerprint: Scribe times words tightly, and speech
 * detection pads speech by about as much. */
const AROUND = 0.15;

/** The runs of a segment's timed words in one voice, where it has one, in
 * seconds of the stream, with `AROUND` on either side. */
function runs(words: Said[]): { voice: number; from: number; to: number }[] {
	const found: { voice: number; from: number; to: number }[] = [];
	for (const { voice, start, end, text } of words) {
		if (voice === null || start === undefined || end === undefined) continue;
		if (!/[\p{L}\p{N}]/u.test(text)) continue;
		const last = found.at(-1);
		if (last?.voice === voice) last.to = end;
		else found.push({ voice, from: start, to: end });
	}
	return found.map((run) => ({
		...run,
		from: Math.max(0, run.from - AROUND),
		to: run.to + AROUND,
	}));
}

/** The letters and digits of a text, lower case, to tell a change. */
function lettersOf(text: string): string {
	return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Text with the Chinese marks Scribe puts after Latin letters made Latin,
 * each followed by a space where a Latin letter follows it right away, as
 * Chinese needs none. */
function latin(text: string, next = ""): string {
	return text.replace(
		LATIN_MARK,
		(mark, _, at: number) =>
			(MARKS[mark] ?? mark) +
			(/\p{Script=Latin}/u.test(text[at + 1] ?? next[0] ?? "") ? " " : ""),
	);
}

/**
 * Speaks lines with Eleven v4 Turbo, one after the other over one
 * connection, which is served only over the dialogue socket.
 */
export class Speech implements Synthesizer {
	private socket: WebSocket | null = null;
	private queue: Promise<void> = Promise.resolve();
	private readonly heartbeat: ReturnType<typeof setInterval>;

	private readonly key: string;
	/** The voices in the order the agents get them, `voice` first. */
	private readonly voices: string[];

	constructor(key: string, voice = VOICE) {
		this.key = key;
		this.voices = [...new Set([voice, ...APART])];
		// The server closes a connection that hears nothing for 20 s.
		this.heartbeat = setInterval(() => {
			if (this.socket?.readyState === WebSocket.OPEN)
				this.socket.send(JSON.stringify({ keep_alive: true }));
		}, 15_000);
	}

	private async connect(): Promise<WebSocket> {
		if (this.socket?.readyState === WebSocket.OPEN) return this.socket;
		const query = new URLSearchParams({
			model_id: "eleven_v4_turbo",
			output_format: `pcm_${SPEECH_RATE}`,
			sync_alignment: "true",
		});
		const socket = new WebSocket(
			`${SOCKETS}/text-to-dialogue/stream-input?${query}`,
		);
		this.socket = socket;
		await opened(socket);
		// The key goes in the first message, never in the URL.
		socket.send(JSON.stringify({ voices: this.voices, xi_api_key: this.key }));
		return socket;
	}

	/** Speaks a line, handing its audio to `piece` as it comes, after the lines before. */
	say(
		line: string,
		piece: (piece: Piece) => boolean,
		voice = 0,
	): Promise<void> {
		const id = this.voices[voice % this.voices.length] ?? VOICE;
		const spoken = this.queue.then(() => this.speak(line, piece, id));
		this.queue = spoken.catch(() => {});
		return spoken;
	}

	private async speak(
		line: string,
		piece: (piece: Piece) => boolean,
		voice: string,
	): Promise<void> {
		const socket = await this.connect();
		await new Promise<void>((resolve, reject) => {
			// An odd byte waits for the next chunk.
			let held = new Uint8Array(0);
			/** Seconds of the line's audio so far. */
			let start = 0;
			const done = (error?: Error) => {
				clearTimeout(timer);
				socket.removeEventListener("message", message);
				socket.removeEventListener("close", ended);
				if (error) reject(error);
				else resolve();
			};
			let timer = setTimeout(() => {}, 0);
			const patience = () => {
				clearTimeout(timer);
				timer = setTimeout(() => {
					// Audio still to come would belong to no line.
					socket.close();
					done(new Error("ElevenLabs did not answer"));
				}, 5000);
			};
			const message = ({ data }: MessageEvent) => {
				patience();
				const m = JSON.parse(String(data));
				if (m.error) return done(refusal(m.error, m.message ?? ""));
				if (m.audio) {
					const audio = unbase64(m.audio);
					const all = new Uint8Array(held.length + audio.length);
					all.set(held);
					all.set(audio, held.length);
					const whole = all.length - (all.length % 2);
					held = all.slice(whole);
					const view = new DataView(all.buffer, 0, whole);
					const samples = new Float32Array(whole / 2);
					for (let i = 0; i < samples.length; i++)
						samples[i] = view.getInt16(2 * i, true) / 32768;
					// Each alignment is timed from the start of the audio it comes with.
					const alignment = m.alignment;
					const chars: Piece["chars"] = (alignment?.chars ?? []).map(
						(char: string, i: number) => ({
							char,
							at: start + (alignment.char_start_times_ms?.[i] ?? 0) / 1000,
						}),
					);
					start += samples.length / SPEECH_RATE;
					piece({ samples, chars });
				}
				if (m.is_final_audio_for_turn || m.is_final) done();
			};
			const ended = (event: CloseEvent) => done(closed(event));
			socket.addEventListener("message", message);
			socket.addEventListener("close", ended);
			patience();
			socket.send(
				JSON.stringify({
					inputs: [{ text: line, voice_id: voice }],
					flush: true,
				}),
			);
		});
	}

	close(): void {
		clearInterval(this.heartbeat);
		this.socket?.close(1000);
		this.socket = null;
	}
}
