// Turn detection off the page's thread, since the models take a while.
// It takes the microphone's 16-bit PCM at 16 kHz, the words heard so far,
// and the person ending a turn by hand, and tells what `Turns` marks, and
// when it heard each chunk of audio, after what the chunk marks.

import wasm from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import * as ort from "onnxruntime-web/wasm";
import { fetchModel, loadModels, SILERO, SMART_TURN } from "./models.ts";
import { type TurnEvent, Turns } from "./turns.ts";

export type ToTurns =
	| { type: "audio"; pcm: ArrayBuffer }
	| { type: "text"; text: string }
	| { type: "end" };

export type FromTurns =
	| TurnEvent
	| { type: "heard" }
	| { type: "ready" }
	| { type: "failed"; error: string };

ort.env.wasm.wasmPaths = { wasm };
// Threads need a cross-origin isolated page.
ort.env.wasm.numThreads = 1;

const post = (message: FromTurns) => postMessage(message);

const turns = Promise.all([fetchModel(SILERO), fetchModel(SMART_TURN)])
	.then(([silero, smartTurn]) => loadModels(silero, smartTurn))
	.then((models) => new Turns(models));
turns.then(
	() => post({ type: "ready" }),
	(error: Error) => post({ type: "failed", error: error.message }),
);

/** Messages are handled one after another, as the models answer in turn. */
let queue: Promise<unknown> = turns;
self.onmessage = ({ data }: MessageEvent<ToTurns>) => {
	queue = queue.then(async () => {
		const detector = await turns;
		if (data.type === "text") return detector.transcribed(data.text);
		if (data.type === "end") return detector.end();
		const pcm = new Int16Array(data.pcm);
		const samples = Float32Array.from(pcm, (s) => s / 32768);
		for (const event of await detector.feed(samples)) post(event);
		post({ type: "heard" });
	});
	queue = queue.catch((error: Error) =>
		post({ type: "failed", error: error.message }),
	);
};
