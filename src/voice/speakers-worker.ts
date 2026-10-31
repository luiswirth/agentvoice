// The voice fingerprint off the page's thread: it keeps the last minute of
// the microphone's 16-bit PCM at 16 kHz, and embeds a stretch of it on
// request, in seconds since the first chunk. It embeds the speech the speaker
// plays too, as it is given. It starts once the page tells it its own
// address, against which the model's is.

import * as ort from "onnxruntime-web/wasm";
import { SPEECH_RATE } from "./engines.ts";
import { fetchModel, REDIMNET2, setUpOnnxRuntime } from "./models.ts";
import { Resampler } from "./resampler.ts";

export type ToSpeakers =
	| { type: "open"; page: string }
	| { type: "audio"; pcm: ArrayBuffer }
	| { type: "embed" | "probe"; from: number; to: number }
	/** Speech the speaker plays, at `SPEECH_RATE`. */
	| { type: "played"; samples: ArrayBuffer };

export type FromSpeakers =
	| { type: "ready" }
	/** The unit-length embedding of an `embed`, answered in order. */
	| { type: "embedding"; embedding: Float32Array }
	/** The same for a `probe`, in the same order. */
	| { type: "probe"; embedding: Float32Array }
	/** The same for speech the speaker plays, in the same order. */
	| { type: "played"; embedding: Float32Array }
	| { type: "failed"; error: string };

setUpOnnxRuntime();

const RATE = 16_000;
const KEPT = 60 * RATE;
const post = (message: FromSpeakers, transfer: Transferable[] = []) =>
	postMessage(message, { transfer });

/** The last `KEPT` samples, the sample `heard` at `heard % KEPT`. */
const kept = new Float32Array(KEPT);
let heard = 0;

/** The shortest stretch embedded, in samples: ReDimNet2 hears frames of 10 ms. */
const SHORTEST = RATE / 10;
const DIMENSIONS = 192;

let opened: (page: string) => void = () => {};
const model = new Promise<string>((resolve) => {
	opened = resolve;
})
	.then((page) =>
		fetchModel({ ...REDIMNET2, url: new URL(REDIMNET2.url, page).href }),
	)
	.then((bytes) =>
		ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] }),
	);
model.then(
	() => post({ type: "ready" }),
	(error: Error) => post({ type: "failed", error: error.message }),
);

/** The microphone's samples from `from` to `to`, in seconds. */
function heardBetween(from: number, to: number): Float32Array {
	const start = Math.max(Math.round(from * RATE), heard - KEPT, 0);
	const end = Math.min(Math.round(to * RATE), heard);
	const samples = new Float32Array(Math.max(0, end - start));
	for (let i = 0; i < samples.length; i++)
		samples[i] = kept[(start + i) % KEPT] ?? 0;
	return samples;
}

/** Speech the speaker plays, at `RATE`. */
function played(samples: Float32Array): Float32Array {
	// Each on its own, since what the speaker plays comes apart.
	return new Resampler(SPEECH_RATE, RATE).push(samples);
}

async function embed(samples: Float32Array): Promise<Float32Array> {
	const embedding = new Float32Array(DIMENSIONS);
	if (samples.length < SHORTEST) return embedding;
	const session = await model;
	const out = await session.run({
		wave: new ort.Tensor("float32", samples, [1, samples.length]),
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
	if (data.type === "open") return opened(data.page);
	if (data.type === "audio") {
		for (const s of new Int16Array(data.pcm)) kept[heard++ % KEPT] = s / 32768;
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
			(embedding) => post({ type, embedding }, [embedding.buffer]),
			(error: Error) => post({ type: "failed", error: error.message }),
		);
};
