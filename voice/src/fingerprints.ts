// The voice fingerprint for a tier that tells its speakers apart itself, as
// Scribe does: it hears the person's audio and what the speaker plays, and
// tells whether a stretch of the audio is the speaker's echo, by the voices
// it heard before, which it keeps in a store.
import type { FromFingerprints, Port, ToFingerprints } from "./reflexes.ts";
import type { Store } from "./store.ts";
import { LISTEN_RATE } from "./tier.ts";
import { SHORTEST, Voices } from "./voices.ts";

export class Fingerprints {
	private readonly port: Port<ToFingerprints, FromFingerprints>;
	private readonly voices: Voices;
	private ready = false;
	/** Seconds of audio heard, and where the speaker sounded in the last minute. */
	private clock = 0;
	private sounded: { from: number; to: number }[] = [];
	/** Who waits for each embedding and probe asked, in order. */
	private readonly embeds: ((embedding: Float32Array | null) => void)[] = [];
	private readonly probes: ((embedding: Float32Array | null) => void)[] = [];

	constructor(port: Port<ToFingerprints, FromFingerprints>, store: Store) {
		this.port = port;
		this.voices = new Voices(store);
		port.receive((data) => {
			if (data.type === "ready") this.ready = true;
			else if (data.type === "failed") {
				this.ready = false;
				for (const wait of [...this.embeds.splice(0), ...this.probes.splice(0)])
					wait(null);
			} else if (data.type === "played") {
				if (data.embedding.some((x) => x !== 0))
					this.voices.play(data.embedding);
			} else if (data.type === "probe") this.probes.shift()?.(data.embedding);
			else this.embeds.shift()?.(data.embedding);
		});
	}

	/** The next 16-bit PCM of the person's audio, and whether the speaker sounded as it was heard. */
	hear(pcm: Int16Array, sounding: boolean): void {
		const from = this.clock;
		this.clock += pcm.length / LISTEN_RATE;
		if (sounding) this.sounded.push({ from, to: this.clock });
		this.sounded = this.sounded.filter(({ to }) => to > this.clock - 60);
		const copy = pcm.slice();
		this.port.post({ type: "audio", pcm: copy.buffer }, [copy.buffer]);
	}

	/** Speech the speaker plays, at `SPEECH_RATE`. */
	played(samples: Float32Array): void {
		const copy = samples.slice();
		this.port.post({ type: "played", samples: copy.buffer }, [copy.buffer]);
	}

	/** Whether the audio from `from` to `to`, in seconds, is the speaker's
	 * echo, learning the person's voice from it where it is not; null where
	 * the fingerprint can't tell. */
	async echo(from: number, to: number): Promise<boolean | null> {
		if (!this.ready) return null;
		// A short one is heard with the sound around it.
		const short = Math.max(0, SHORTEST - (to - from)) / 2;
		const embedding = await this.ask(
			{ type: "embed", from: from - short, to: to + short },
			this.embeds,
		);
		if (embedding === null) return null;
		const sounding = this.sounding(from, to);
		if (to - from < SHORTEST)
			return this.voices.guess(embedding, sounding).played;
		return this.voices.stretch(from, to, embedding, sounding).stretch.played;
	}

	/** Whether the audio from `from` to `to` sounds like the speaker's echo,
	 * without learning from it; null where the fingerprint can't tell. */
	async probe(from: number, to: number): Promise<boolean | null> {
		if (!this.ready) return null;
		const embedding = await this.ask({ type: "probe", from, to }, this.probes);
		if (embedding === null) return null;
		return this.voices.closest(embedding, this.sounding(from, to)).played;
	}

	close(): void {
		this.port.close();
	}

	/** Whether the speaker sounded between `from` and `to`, in seconds. */
	sounding(from: number, to: number): boolean {
		return this.sounded.some((s) => s.to > from && s.from < to);
	}

	private ask(
		message: ToFingerprints,
		queue: ((embedding: Float32Array | null) => void)[],
	): Promise<Float32Array | null> {
		this.port.post(message);
		return new Promise((answer) =>
			queue.push((embedding) =>
				answer(embedding?.some((x) => x !== 0) ? embedding : null),
			),
		);
	}
}
