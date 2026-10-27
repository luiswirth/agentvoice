// The speaker model off the page's thread: it keeps the last minute of the
// microphone's 16-bit PCM at 16 kHz, and embeds a stretch of it on request,
// in seconds since the first chunk.

import * as ort from "onnxruntime-web/wasm";
import { FBANK_BINS, fbank } from "./fbank.ts";
import { CAMPLUS, fetchModel, setUpOnnxRuntime } from "./models.ts";

export type ToSpeakers =
	| { type: "audio"; pcm: ArrayBuffer }
	| { type: "embed" | "probe"; from: number; to: number };

export type FromSpeakers =
	| { type: "ready" }
	/** The unit-length embedding of an `embed`, answered in order. */
	| { type: "embedding"; embedding: Float32Array }
	/** The same for a `probe`, in the same order. */
	| { type: "probe"; embedding: Float32Array }
	| { type: "failed"; error: string };

setUpOnnxRuntime();

const RATE = 16_000;
const KEPT = 60 * RATE;
const post = (message: FromSpeakers, transfer: Transferable[] = []) =>
	postMessage(message, { transfer });

/** The last `KEPT` samples, the sample `heard` at `heard % KEPT`. */
const kept = new Float32Array(KEPT);
let heard = 0;

const model = fetchModel(CAMPLUS).then((bytes) =>
	ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] }),
);
model.then(
	() => post({ type: "ready" }),
	(error: Error) => post({ type: "failed", error: error.message }),
);

async function embed(from: number, to: number): Promise<Float32Array> {
	const start = Math.max(Math.round(from * RATE), heard - KEPT, 0);
	const end = Math.min(Math.round(to * RATE), heard);
	const samples = new Float32Array(Math.max(0, end - start));
	for (let i = 0; i < samples.length; i++)
		samples[i] = kept[(start + i) % KEPT] ?? 0;
	const features = fbank(samples);
	const frames = features.length / FBANK_BINS;
	const embedding = new Float32Array(512);
	if (frames < 10) return embedding;
	const session = await model;
	const out = await session.run({
		x: new ort.Tensor("float32", features, [1, frames, FBANK_BINS]),
	});
	embedding.set(out.embedding?.data as Float32Array);
	const norm = Math.hypot(...embedding) || 1;
	for (let i = 0; i < embedding.length; i++)
		embedding[i] = (embedding[i] ?? 0) / norm;
	return embedding;
}

/** Requests are answered one after another, as the model answers in turn. */
let queue: Promise<unknown> = Promise.resolve();
self.onmessage = ({ data }: MessageEvent<ToSpeakers>) => {
	if (data.type === "audio") {
		for (const s of new Int16Array(data.pcm)) kept[heard++ % KEPT] = s / 32768;
		return;
	}
	const type = data.type === "probe" ? "probe" : "embedding";
	queue = queue
		.then(() => embed(data.from, data.to))
		.then(
			(embedding) => post({ type, embedding }, [embedding.buffer]),
			(error: Error) => post({ type: "failed", error: error.message }),
		);
};
