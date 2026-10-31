// ElevenLabs, reached straight from the browser with the user's own key:
// Scribe v2 Realtime hears, Eleven v4 Turbo speaks. Nothing here touches an
// audio device, so it runs in Node as well.

import {
	type Heard,
	LISTEN_RATE,
	Offsets,
	type Piece,
	SPEECH_RATE,
	type Synthesizer,
	type Transcriber,
	type Word,
} from "./engines.ts";

const API = "https://api.elevenlabs.io/v1";
const SOCKETS = "wss://api.elevenlabs.io/v1";

/** Arthur, a library voice: "clear, engaging", an audiobook narrator. */
export const VOICE = "C1npRmjB19a6yNkEucvx";

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

/** Scribe bills every second of audio it is sent, silence included, and
 * closes a session that is sent none for about 15 s. */
const KEEPALIVE = 5 * LISTEN_RATE;
/** What keeps the session open: 10 ms of silence. */
const ALIVE = new Int16Array(LISTEN_RATE / 100);

/** A Scribe session over a stream, of which it hears what `hear` gives it
 * and skips the rest, so that only what is heard is paid for; its segments
 * end where `commit` settles them, or on their own after about 36 s. */
export class Scribe implements Transcriber {
	/** Samples sent since the last commit: Scribe refuses a commit of under 0.3 s, and closes. */
	uncommitted = 0;
	/** Commits not yet answered. */
	private commits = 0;
	/** Samples skipped since the last sent. */
	private quiet = 0;
	private readonly offsets = new Offsets();

	/** Samples sent in all, which Scribe bills. */
	get sent(): number {
		return this.offsets.sent;
	}

	private readonly socket: WebSocket;

	private constructor(socket: WebSocket) {
		this.socket = socket;
	}

	/** `languages`: what the person speaks, most likely first, as BCP 47 tags
	 * or bare codes; Scribe hears only these, and detects the language
	 * where there are none. */
	static async open(
		key: string,
		heard: Heard,
		languages: readonly string[],
	): Promise<Scribe> {
		const query = new URLSearchParams({
			model_id: "scribe_v2_realtime",
			token: await token(key, "realtime_scribe"),
			audio_format: `pcm_${LISTEN_RATE}`,
			commit_strategy: "manual",
			include_timestamps: "true",
		});
		const codes = languages.map(
			(tag) => tag.split("-")[0]?.toLowerCase() ?? "",
		);
		const [first, ...rest] = [...new Set(codes)].filter((code) => code !== "");
		if (first !== undefined) query.set("language_code", first);
		for (const code of rest) query.append("secondary_languages", code);
		const socket = new WebSocket(`${SOCKETS}/speech-to-text/realtime?${query}`);
		const scribe = new Scribe(socket);
		socket.addEventListener("message", ({ data }) => {
			const message = JSON.parse(String(data));
			switch (message.message_type) {
				case "partial_transcript":
					heard.partial(message.text ?? "");
					return;
				// Each commit comes twice, the second time with its words.
				case "committed_transcript":
					return;
				case "committed_transcript_with_timestamps": {
					const automatic = scribe.commits === 0;
					if (automatic) scribe.uncommitted = 0;
					else scribe.commits--;
					const words: Word[] = message.words ?? [];
					heard.committed(
						message.text ?? "",
						automatic,
						words.map((word) => scribe.offsets.place(word)),
					);
					return;
				}
				default:
					if (message.error) {
						heard.closed(refusal(message.message_type, message.error));
						socket.close();
					}
			}
		});
		socket.addEventListener("close", (event) =>
			heard.closed(event.code === 1000 ? undefined : closed(event)),
		);
		await opened(socket);
		return scribe;
	}

	/** The stream's next 16-bit PCM at `LISTEN_RATE`, to transcribe. */
	hear(pcm: Int16Array): void {
		this.quiet = 0;
		if (this.send(pcm)) this.offsets.hear(pcm.length);
		else this.offsets.skip(pcm.length);
	}

	/** The stream's next `samples`, not to transcribe. */
	skip(samples: number): void {
		this.offsets.skip(samples);
		this.quiet += samples;
		if (this.quiet < KEEPALIVE) return;
		this.quiet = 0;
		if (this.send(ALIVE)) this.offsets.pad(ALIVE.length);
	}

	/** Scribe hears a turn as one stream, since a commit at each pause gives
	 * each stretch a sentence of its own. */
	spoke(): void {}
	paused(): void {}

	/** Whether it was sent. */
	private send(pcm: Int16Array): boolean {
		if (this.socket.readyState !== WebSocket.OPEN) return false;
		this.uncommitted += pcm.length;
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
		return true;
	}

	/** Settles the segment in progress, if it holds enough audio to; whether it did. */
	commit(): boolean {
		if (this.uncommitted < (2 * LISTEN_RATE) / 5) return false;
		this.uncommitted = 0;
		this.commits++;
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

/**
 * Speaks lines with Eleven v4 Turbo, one after the other over one
 * connection, which is served only over the dialogue socket.
 */
export class Speech implements Synthesizer {
	private socket: WebSocket | null = null;
	private queue: Promise<void> = Promise.resolve();
	private readonly heartbeat: ReturnType<typeof setInterval>;

	private readonly key: string;
	private readonly voice: string;

	constructor(key: string, voice = VOICE) {
		this.key = key;
		this.voice = voice;
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
		socket.send(JSON.stringify({ voices: [this.voice], xi_api_key: this.key }));
		return socket;
	}

	/** Speaks a line, handing its audio to `piece` as it comes, after the lines before. */
	say(line: string, piece: (piece: Piece) => boolean): Promise<void> {
		const spoken = this.queue.then(() => this.speak(line, piece));
		this.queue = spoken.catch(() => {});
		return spoken;
	}

	private async speak(
		line: string,
		piece: (piece: Piece) => boolean,
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
					inputs: [{ text: line, voice_id: this.voice }],
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
