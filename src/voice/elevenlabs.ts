// ElevenLabs, reached straight from the browser with the user's own key:
// Scribe v3 Live hears, Eleven v4 Turbo speaks. Nothing here touches an
// audio device, so it runs in Node as well.

import {
	type Hearer,
	LISTEN_RATE,
	type Perception,
	type Piece,
	type Said,
	SPEECH_RATE,
	type Synthesizer,
} from "voice-core";

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

/** How long a segment gets, in seconds, before Scribe ends it on its own,
 * at about 36 s, whether or not the person paused: such an end is no turn's,
 * and its words go on into the next segment. */
const LONGEST = 30;

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

/**
 * Scribe v3 Live's hearing over the whole of listening, on its own turn
 * prediction and its own speaker labels: a segment ends as `END` judges it,
 * and each word takes the voice of its label. Scribe numbers the voices of
 * one session, so a new session numbers them anew: nothing maps one
 * session's voices to another's.
 */
export class Scribe implements Hearer {
	/** Samples sent since the last commit: Scribe refuses a commit of under 0.3 s, and closes. */
	private uncommitted = 0;
	/** How long the segment Scribe ended last is, in samples. */
	private length = 0;
	/** The words of segments Scribe ended on its own, for their length, which
	 * go on into the next. */
	private held: Said[] = [];
	/** Which label each merged label became. */
	private readonly merged = new Map<string, string>();
	/** The voice heard last, and how sure Scribe is that the turn is done. */
	private voice: number | null | undefined;
	private probability = 0;
	/** Why the segment in progress is being ended, once a commit is sent. */
	private asked: string | null = null;
	/** Seconds of audio sent, and where its words last changed. */
	private sent = 0;
	private changed = 0;
	/** The words of the segment in progress, as letters, to tell a change. */
	private letters = "";
	private readonly socket: WebSocket;
	private readonly heard: Perception;

	private constructor(socket: WebSocket, heard: Perception) {
		this.socket = socket;
		this.heard = heard;
	}

	/** `languages`: what the person speaks, most likely first, as BCP 47 tags
	 * or bare codes; Scribe hears only these, following the person from one
	 * to another, and detects the language where there are none. */
	static async open(
		key: string,
		heard: Perception,
		languages: readonly string[],
	): Promise<Scribe> {
		const query = new URLSearchParams({
			model_id: "scribe_v3_live",
			token: await token(key, "realtime_scribe"),
			audio_format: `pcm_${LISTEN_RATE}`,
			commit_strategy: "manual",
			diarize: "true",
			// A partial at least every second, so that a silence is judged in time.
			keepalive_interval_ms: "1000",
		});
		const codes = languages.map(
			(tag) => tag.split("-")[0]?.toLowerCase() ?? "",
		);
		const [first, ...rest] = [...new Set(codes)].filter((code) => code !== "");
		if (first !== undefined) query.set("language_code", first);
		for (const code of rest) query.append("secondary_languages", code);
		if (rest.length > 0) query.set("multilang_mode", "true");
		const socket = new WebSocket(`${SOCKETS}/speech-to-text/realtime?${query}`);
		const scribe = new Scribe(socket, heard);
		socket.addEventListener("message", ({ data }) =>
			scribe.receive(JSON.parse(String(data))),
		);
		socket.addEventListener("close", (event) => {
			if (event.code !== 1000) heard.failed(closed(event));
		});
		await opened(socket);
		return scribe;
	}

	private receive(message: Record<string, unknown>): void {
		switch (message.message_type) {
			case "partial_transcript": {
				const words = this.said(message);
				this.probability = Number(message.turn_probability ?? 0);
				const voice = words.findLast((w) => w.voice !== null)?.voice;
				if (voice !== undefined && voice !== this.voice) {
					this.voice = voice;
					this.heard.voice(voice);
				}
				this.heard.partial(this.after(words));
				this.judge(String(message.text ?? ""));
				return;
			}
			// A segment ends with its labels, which come right after.
			case "committed_transcript":
				this.length = this.uncommitted;
				this.uncommitted = 0;
				return;
			case "diarized_transcript": {
				const words = this.after(this.said(message));
				const asked = this.asked;
				this.asked = null;
				this.letters = "";
				if (asked === null && this.length >= LONGEST * LISTEN_RATE) {
					this.heard.trace("cut", { probability: this.probability });
					this.held = words;
					return;
				}
				this.heard.trace("turn.end", {
					reason: asked ?? "silence",
					probability: this.probability,
				});
				this.held = [];
				this.voice = undefined;
				this.probability = 0;
				this.heard.segment(words);
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
					this.heard.failed(
						refusal(String(message.message_type), String(message.error)),
					);
					this.socket.close();
				}
		}
	}

	/** Words after those held, if any. */
	private after(words: Said[]): Said[] {
		if (this.held.length === 0) return words;
		return [...this.held, { text: " ", voice: null }, ...words];
	}

	/** A message's words, each with the voice of its label, or its text as
	 * one word where it has none. */
	private said(message: Record<string, unknown>): Said[] {
		const words = (message.words ?? []) as Labeled[];
		if (words.length === 0)
			return [{ text: latin(String(message.text ?? "")), voice: null }];
		return words.map((word, i) => ({
			text: latin(word.text, words[i + 1]?.text),
			voice: this.number(word.speaker_id ?? null),
			start: word.start ?? undefined,
			end: word.end ?? undefined,
		}));
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

	/** The next 0.1 s of the person's audio: Scribe hears all of it. */
	hear(pcm: Int16Array): void {
		if (this.socket.readyState !== WebSocket.OPEN) return;
		this.uncommitted += pcm.length;
		this.sent += pcm.length / LISTEN_RATE;
		this.socket.send(
			JSON.stringify({
				message_type: "input_audio_chunk",
				audio_base_64: base64(
					new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
				),
				commit: false,
				sample_rate: LISTEN_RATE,
			}),
		);
	}

	/** Ends the segment in progress where Scribe's turn prediction and the
	 * silence since its words last changed say the person is done. */
	private judge(text: string): void {
		const letters = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
		if (letters !== this.letters) {
			this.letters = letters;
			this.changed = this.sent;
		}
		if (letters === "" || this.asked !== null) return;
		const silence = this.sent - this.changed;
		const p = this.probability;
		if (p >= END.sure) this.commit("turn");
		else if (silence >= END.wait && p >= END.likely) this.commit("wait");
		else if (silence >= END.longest) this.commit("silence");
	}

	/** Ends the segment in progress now, if it holds enough audio to; whether it will. */
	finish(): boolean {
		return this.commit("by hand");
	}

	/** Ends the segment in progress for `why`, if it holds enough audio to; whether it will. */
	private commit(why: string): boolean {
		if (this.asked !== null) return true;
		if (this.uncommitted < (2 * LISTEN_RATE) / 5) return false;
		if (this.socket.readyState !== WebSocket.OPEN) return false;
		this.uncommitted = 0;
		this.asked = why;
		this.socket.send(
			JSON.stringify({
				message_type: "input_audio_chunk",
				audio_base_64: "",
				commit: true,
				sample_rate: LISTEN_RATE,
			}),
		);
		return true;
	}

	close(): void {
		this.socket.close(1000);
	}
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
