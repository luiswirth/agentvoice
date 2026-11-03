// The reflexes off the core's thread, since the models take a while: turn
// detection, and the voice fingerprint. Each runs behind a port, such as a
// worker's, which the host makes: the core asks through one end, and the
// host serves the other with `serveTurns` and `serveFingerprints`, given the
// models' bytes.
import * as ort from "onnxruntime-web/wasm";
import { loadModels } from "./models.ts";
import { Resampler } from "./resampler.ts";
import { SPEECH_RATE } from "./tier.ts";
import { type TurnEvent, Turns } from "./turns.ts";

/** One end of a channel of messages, as a worker's: what is posted on one
 * end is received on the other, in order. */
export type Port<Out, In> = {
	post(message: Out, transfer?: ArrayBuffer[]): void;
	/** Takes each message received, and the channel failing, as a worker
	 * whose script fails. */
	receive(
		message: (message: In) => void,
		failed?: (error: Error) => void,
	): void;
	close(): void;
};

/** The host's ports to the reflexes, a new one of each as listening opens. */
export type Reflexes = {
	turns(): Port<ToTurns, FromTurns>;
	fingerprints(): Port<ToFingerprints, FromFingerprints>;
};

/** Turn detection takes the microphone's 16-bit PCM at 16 kHz, the words
 * heard so far, and the person ending a turn by hand, and tells what `Turns`
 * marks, and when it heard each chunk of audio, after what the chunk marks. */
export type ToTurns =
	| { type: "audio"; pcm: ArrayBuffer }
	| { type: "text"; text: string }
	| { type: "end" };

export type FromTurns =
	| TurnEvent
	| { type: "heard" }
	| { type: "ready" }
	| { type: "failed"; error: string };

/** Serves turn detection on `port`, with Silero's and Smart Turn's bytes. */
export function serveTurns(
	port: Port<FromTurns, ToTurns>,
	models: Promise<[silero: Uint8Array, smartTurn: Uint8Array]>,
): void {
	const turns = models
		.then(([silero, smartTurn]) => loadModels(silero, smartTurn))
		.then((models) => new Turns(models));
	turns.then(
		() => port.post({ type: "ready" }),
		(error: Error) => port.post({ type: "failed", error: error.message }),
	);
	/** Messages are handled one after another, as the models answer in turn. */
	let queue: Promise<unknown> = turns;
	port.receive((data) => {
		queue = queue.then(async () => {
			const detector = await turns;
			if (data.type === "text") return detector.transcribed(data.text);
			if (data.type === "end") return detector.end();
			const pcm = new Int16Array(data.pcm);
			const samples = Float32Array.from(pcm, (s) => s / 32768);
			for (const event of await detector.feed(samples)) port.post(event);
			port.post({ type: "heard" });
		});
		queue = queue.catch((error: Error) =>
			port.post({ type: "failed", error: error.message }),
		);
	});
}

/** The voice fingerprint keeps the last minute of the microphone's 16-bit
 * PCM at 16 kHz, and embeds a stretch of it on request, in seconds since the
 * first chunk. It embeds the speech the speaker plays too, as it is given. */
export type ToFingerprints =
	| { type: "audio"; pcm: ArrayBuffer }
	| { type: "embed" | "probe"; from: number; to: number }
	/** Speech the speaker plays, at `SPEECH_RATE`. */
	| { type: "played"; samples: ArrayBuffer };

export type FromFingerprints =
	| { type: "ready" }
	/** The unit-length embedding of an `embed`, answered in order. */
	| { type: "embedding"; embedding: Float32Array }
	/** The same for a `probe`, in the same order. */
	| { type: "probe"; embedding: Float32Array }
	/** The same for speech the speaker plays, in the same order. */
	| { type: "played"; embedding: Float32Array }
	| { type: "failed"; error: string };

const RATE = 16_000;
const KEPT = 60 * RATE;
/** The shortest stretch embedded, in samples: ReDimNet2 hears frames of 10 ms. */
const SHORTEST = RATE / 10;
const DIMENSIONS = 192;

/** Serves the voice fingerprint on `port`, with ReDimNet2's bytes. */
export function serveFingerprints(
	port: Port<FromFingerprints, ToFingerprints>,
	model: Promise<Uint8Array>,
): void {
	const post = (message: FromFingerprints, transfer: ArrayBuffer[] = []) =>
		port.post(message, transfer);
	const session = model.then((bytes) =>
		ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] }),
	);
	session.then(
		() => post({ type: "ready" }),
		(error: Error) => post({ type: "failed", error: error.message }),
	);

	/** The last `KEPT` samples, the sample `heard` at `heard % KEPT`. */
	const kept = new Float32Array(KEPT);
	let heard = 0;

	/** The microphone's samples from `from` to `to`, in seconds. */
	const heardBetween = (from: number, to: number): Float32Array => {
		const start = Math.max(Math.round(from * RATE), heard - KEPT, 0);
		const end = Math.min(Math.round(to * RATE), heard);
		const samples = new Float32Array(Math.max(0, end - start));
		for (let i = 0; i < samples.length; i++)
			samples[i] = kept[(start + i) % KEPT] ?? 0;
		return samples;
	};

	/** Speech the speaker plays, at `RATE`: each on its own, since what the
	 * speaker plays comes apart. */
	const played = (samples: Float32Array): Float32Array =>
		new Resampler(SPEECH_RATE, RATE).push(samples);

	const embed = async (samples: Float32Array): Promise<Float32Array> => {
		const embedding = new Float32Array(DIMENSIONS);
		if (samples.length < SHORTEST) return embedding;
		const out = await (await session).run({
			wave: new ort.Tensor("float32", samples, [1, samples.length]),
		});
		embedding.set(out.embedding?.data as Float32Array);
		const norm = Math.hypot(...embedding) || 1;
		for (let i = 0; i < embedding.length; i++)
			embedding[i] = (embedding[i] ?? 0) / norm;
		return embedding;
	};

	/** Requests are answered one after another, as the model answers in turn. */
	let queue: Promise<unknown> = Promise.resolve();
	port.receive((data) => {
		if (data.type === "audio") {
			for (const s of new Int16Array(data.pcm))
				kept[heard++ % KEPT] = s / 32768;
			return;
		}
		const type = data.type === "embed" ? "embedding" : data.type;
		const samples =
			data.type === "played"
				? played(new Float32Array(data.samples))
				: heardBetween(data.from, data.to);
		queue = queue
			.then(() => embed(samples))
			.then(
				(embedding) =>
					post({ type, embedding }, [embedding.buffer as ArrayBuffer]),
				(error: Error) => post({ type: "failed", error: error.message }),
			);
	});
}
