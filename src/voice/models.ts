// The reflexes' models, on ONNX Runtime Web: Silero VAD hears whether the
// person speaks, Smart Turn whether they sound finished, and ReDimNet2 gives
// each stretch its voice fingerprint. Each is fetched once, at a pinned
// revision, checked against its hash.
import mjs from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
import wasm from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import * as ort from "onnxruntime-web/wasm";
import { logMel, MEL_BINS } from "./mel.ts";
import { CONTEXT, type Models, WINDOW } from "./turns.ts";

/**
 * Sets up ONNX Runtime in a worker, before its first session. ONNX Runtime
 * builds only with threads, so its memory is shared, and Safari reserves a
 * shared memory's whole maximum up front: the iPhone runs out after a few.
 * ONNX Runtime's maximum of 4 GiB is fixed in its build, so voice carries a
 * patch of its glue (`patches/`) that lowers it to 256 MiB, which it loads
 * rather than the glue in its bundle. Turn detection needs 49 MiB; in it, the
 * fingerprint model embeds up to 15 s at once, as measured in Chromium, and
 * the listener gives it at most 10.
 */
export function setUpOnnxRuntime(): void {
	ort.env.wasm.wasmPaths = { mjs, wasm };
	// Threads need a cross-origin isolated page.
	ort.env.wasm.numThreads = 1;
}

export type Model = { url: string; integrity: string };

/** Silero VAD v6.2.1, 2.3 MB. */
export const SILERO: Model = {
	url: "https://raw.githubusercontent.com/snakers4/silero-vad/v6.2.1/src/silero_vad/data/silero_vad.onnx",
	integrity: "sha256-GhU6IvRQnikqlOZ9b5uF6N6yW0mIaCt+F0xlJ52HiOM=",
};

/** Smart Turn v3.2, quantized to 8 bits, 8.7 MB. */
export const SMART_TURN: Model = {
	url: "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93/smart-turn-v3.2-cpu.onnx",
	integrity: "sha256-K7AmMWsUpmBIanWxczzT+6uML9AxTcmve+SfjMqWfk8=",
};

/** The voice fingerprint: ReDimNet2 b3, trained on VoxBlink2, VoxCeleb2 and
 * CN-Celeb, in voice's own export (`models/export-redimnet2.py`), 19 MB, which
 * the page serves itself. It takes raw 16 kHz audio of any length and gives a
 * 192-dimensional embedding, compared by cosine. `url` is relative to the
 * page, which a worker doesn't know on its own. */
export const REDIMNET2: Model = {
	url: "models/redimnet2-b3-vb2-vox2-cnc2-lm.onnx",
	integrity: "sha256-moKKovf+N6NMQ8i2uGjyyNqXAwybYvwVLvKXYvFF+ac=",
};

const CACHE = "voice-models";

/** A model's bytes, from the browser's cache once fetched. */
export async function fetchModel({
	url,
	integrity,
}: Model): Promise<Uint8Array> {
	const cache = await caches.open(CACHE);
	const cached = await cache.match(url);
	if (cached !== undefined) return new Uint8Array(await cached.arrayBuffer());
	const response = await fetch(url, { integrity });
	if (!response.ok)
		throw new Error(`Fetching ${url} failed: ${response.status}`);
	await cache.put(url, response.clone());
	return new Uint8Array(await response.arrayBuffer());
}

/** The audio Smart Turn hears: the last 8 s. */
const HEARD = 8 * 16_000;
/** Silero's state, as the model takes it: [2, 1, 128]. */
const STATE = 2 * 128;

export async function loadModels(
	silero: Uint8Array,
	smartTurn: Uint8Array,
): Promise<Models> {
	const options = { executionProviders: ["wasm"] };
	const vad = await ort.InferenceSession.create(silero, options);
	const turn = await ort.InferenceSession.create(smartTurn, options);
	const rate = new ort.Tensor("int64", BigInt64Array.from([16_000n]), []);
	return {
		initial: () => new Float32Array(STATE),
		async voiced(window, state) {
			const out = await vad.run({
				input: new ort.Tensor("float32", window, [1, CONTEXT + WINDOW]),
				state: new ort.Tensor("float32", state, [2, 1, 128]),
				sr: rate,
			});
			state.set(data(out, "stateN"));
			return data(out, "output")[0] ?? 0;
		},
		async finished(audio) {
			const samples = new Float32Array(HEARD);
			const tail = audio.subarray(Math.max(0, audio.length - HEARD));
			samples.set(tail, HEARD - tail.length);
			const features = logMel(samples);
			const out = await turn.run({
				input_features: new ort.Tensor("float32", features, [
					1,
					MEL_BINS,
					features.length / MEL_BINS,
				]),
			});
			return data(out, "logits")[0] ?? 0;
		},
	};
}

function data(
	outputs: ort.InferenceSession.OnnxValueMapType,
	name: string,
): Float32Array {
	const output = outputs[name];
	if (output === undefined) throw new Error(`The model gave no ${name}.`);
	return output.data as Float32Array;
}
