// The local models of turn detection, on ONNX Runtime Web: Silero VAD hears
// whether the person speaks, Smart Turn whether they sound finished. Each is
// fetched once, at a pinned revision, checked against its hash.
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
 * rather than the glue in its bundle. The speaker model needs 93 MiB at most,
 * turn detection 49 MiB, as measured in Chromium.
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

/** 3D-Speaker's CAM++, trained on VoxCeleb, in sherpa-onnx's export, 30 MB:
 * the speaker model, a 512-dimensional embedding of a stretch of speech. */
export const CAMPLUS: Model = {
	url: "https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/0743f301363dec56491a490f6d6cbc9d67f9a3bf/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx",
	integrity: "sha256-NXqDT3ArgBYeW5gRgsA44YVTwfLKdS7WzsIFI2XUEps=",
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
