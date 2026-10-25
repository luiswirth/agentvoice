// The page's trace of what voice does, for the person's own agent to read and
// fix voice from, with the audio the listener heard. Kept on the page from
// when it opens, the events across reloads of its tab too, and sent into the
// session only while the person shares it, which is off until they turn it
// on: at once as they turn it on, and then with each message they send.

/** A trace of what voice did since the last one was sent, or since the page
 * opened. */
export const TRACE = "application/vnd.byoa.voice.trace+json";

import { LISTEN_RATE } from "./elevenlabs.ts";

export type TraceEvent = { time: string; event: string } & Record<
	string,
	unknown
>;

const SHARING = "voice-sharing-trace";

/** The most events kept, the oldest dropped first. */
const KEPT = 5_000;
/** The most audio kept, in samples, the oldest dropped first: well under
 * the transport's 10 MB a payload. */
const KEPT_AUDIO = 5 * 60 * LISTEN_RATE;

/** Audio the listener heard without a gap, at `LISTEN_RATE`, from `start`. */
type Stretch = { start: number; chunks: Int16Array[]; length: number };

/** A stretch of what the listener heard, as a WAV, and when it starts. */
export type Heard = { start: string; wav: Blob };

export class Trace {
	/** Kept for the tab and the page's link, so that a reload keeps it and
	 * another session never gets it. */
	private readonly key = `voice-trace ${location.href}`;
	private events: TraceEvent[] = JSON.parse(
		sessionStorage.getItem(this.key) ?? "[]",
	);
	sharing = localStorage.getItem(SHARING) === "true";
	private audio: Stretch[] = [];
	/** When the last chunk of audio came, in ms. */
	private last = 0;

	share(on: boolean): void {
		this.sharing = on;
		localStorage.setItem(SHARING, String(on));
	}

	event(event: string, data: Record<string, unknown> = {}): void {
		this.events.push({ time: new Date().toISOString(), event, ...data });
		if (this.events.length > KEPT) this.events.shift();
		this.keep();
	}

	/** A chunk of what the listener hears, as it hears it. */
	hear(pcm: Int16Array): void {
		const now = Date.now();
		const ms = (1000 * pcm.length) / LISTEN_RATE;
		let stretch = this.audio.at(-1);
		// A chunk late by more than its own length starts a stretch of its own.
		if (stretch === undefined || now - this.last > 2 * ms + 100) {
			stretch = { start: now - ms, chunks: [], length: 0 };
			this.audio.push(stretch);
		}
		stretch.chunks.push(pcm.slice());
		stretch.length += pcm.length;
		this.last = now;
		let kept = this.audio.reduce((sum, s) => sum + s.length, 0);
		while (kept > KEPT_AUDIO) {
			const first = this.audio[0];
			const chunk = first?.chunks.shift();
			if (first === undefined || chunk === undefined) break;
			first.start += (1000 * chunk.length) / LISTEN_RATE;
			first.length -= chunk.length;
			kept -= chunk.length;
			if (first.chunks.length === 0) this.audio.shift();
		}
	}

	/** The events and the audio since the last take, while shared, and none
	 * otherwise. */
	take(): { events: TraceEvent[]; audio: Heard[] } {
		if (!this.sharing) return { events: [], audio: [] };
		const events = this.events;
		const audio = this.audio.map((stretch) => ({
			start: new Date(stretch.start).toISOString(),
			wav: wave(stretch.chunks, stretch.length),
		}));
		this.events = [];
		this.audio = [];
		this.keep();
		return { events, audio };
	}

	/** Past the storage's quota, the trace is kept in memory only. */
	private keep(): void {
		try {
			sessionStorage.setItem(this.key, JSON.stringify(this.events));
		} catch {}
	}
}

/** 16-bit mono PCM at `LISTEN_RATE`, as a WAV. */
function wave(chunks: Int16Array[], length: number): Blob {
	const header = new DataView(new ArrayBuffer(44));
	const text = (at: number, s: string) => {
		for (let i = 0; i < s.length; i++) header.setUint8(at + i, s.charCodeAt(i));
	};
	text(0, "RIFF");
	header.setUint32(4, 36 + 2 * length, true);
	text(8, "WAVEfmt ");
	header.setUint32(16, 16, true);
	header.setUint16(20, 1, true);
	header.setUint16(22, 1, true);
	header.setUint32(24, LISTEN_RATE, true);
	header.setUint32(28, 2 * LISTEN_RATE, true);
	header.setUint16(32, 2, true);
	header.setUint16(34, 16, true);
	text(36, "data");
	header.setUint32(40, 2 * length, true);
	return new Blob([header, ...chunks] as BlobPart[], { type: "audio/wav" });
}
