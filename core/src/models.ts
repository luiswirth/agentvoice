// The reflexes' models, on ONNX Runtime Web: Silero VAD hears whether the
// person speaks, Smart Turn whether they sound finished, and ReDimNet2 gives
// each stretch its voice fingerprint. Each is at a pinned revision, with its
// hash, for the host to fetch and check; where ONNX Runtime finds its own
// files is the host's to set up too.
import * as ort from "onnxruntime-web/wasm";
import { logMel, MEL_BINS } from "./mel.ts";
import { CONTEXT, type Models, WINDOW } from "./turns.ts";

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
 * 192-dimensional embedding, compared by cosine. `url` is relative to
 * where the host serves voice's files: in this repository, `public/`. */
export const REDIMNET2: Model = {
	url: "models/redimnet2-b3-vb2-vox2-cnc2-lm.onnx",
	integrity: "sha256-moKKovf+N6NMQ8i2uGjyyNqXAwybYvwVLvKXYvFF+ac=",
};

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
