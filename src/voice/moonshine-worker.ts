// Moonshine off the page's thread, since a pass over a turn takes a while.
// It hears each segment whole, as one line: without the voice detection
// that cuts a stream into lines, which costs it accuracy, and with a second
// of silence after it, without which its last word is lost.

import {
	ModelArch,
	type Stream,
	Transcriber,
	type Transcript,
} from "@moonshine-ai/moonshine-wasm";
import { LISTEN_RATE, type Word } from "./engines.ts";
import { capSharedMemory } from "./shared-memory.ts";

export type ToMoonshine =
	| { type: "audio"; pcm: ArrayBuffer }
	| { type: "commit" }
	/** Drops the segment in progress, for the next listener. */
	| { type: "reset" };

export type FromMoonshine =
	| { type: "ready" }
	| { type: "failed"; error: string }
	| { type: "partial"; text: string }
	/** Everything before it belongs to the listener before. */
	| { type: "reset" }
	/** `words`: one per line, with a space between lines, timed in seconds
	 * of the segment. */
	| { type: "committed"; text: string; words: Word[] };

const post = (message: FromMoonshine) => postMessage(message);

/** The silence after a segment. */
const TAIL = new Float32Array(LISTEN_RATE);

capSharedMemory(1);

const loaded = Transcriber.load({
	language: "en",
	modelArch: ModelArch.SmallStreaming,
	options: { vad_threshold: "0", vad_max_segment_duration: "30" },
}).then((transcriber) => {
	const stream = transcriber.createStream();
	stream.start();
	return stream;
});
loaded.then(
	() => post({ type: "ready" }),
	(error: Error) =>
		post({ type: "failed", error: String(error.message ?? error) }),
);

function text({ lines }: Transcript): string {
	return lines
		.map((line) => line.text.trim())
		.filter((line) => line !== "")
		.join(" ");
}

let partial = "";

function handle(stream: Stream, message: ToMoonshine): void {
	if (message.type === "audio") {
		const pcm = new Int16Array(message.pcm);
		const audio = Float32Array.from(pcm, (sample) => sample / 32768);
		stream.addAudio(audio, LISTEN_RATE);
		// A pass comes only once there is enough new audio for one.
		const heard = text(stream.transcribe());
		if (heard !== partial) post({ type: "partial", text: heard });
		partial = heard;
		return;
	}
	if (message.type === "reset") {
		stream.stop();
		stream.start();
		partial = "";
		post({ type: "reset" });
		return;
	}
	stream.addAudio(TAIL, LISTEN_RATE);
	// Stopping makes the last pass, which a pass right after returns.
	stream.stop();
	const transcript = stream.transcribe();
	const words: Word[] = [];
	for (const line of transcript.lines) {
		const said = line.text.trim();
		if (said === "") continue;
		const start = line.startTime;
		if (words.length > 0) words.push({ text: " ", start, end: start });
		words.push({ text: said, start, end: start + line.duration });
	}
	post({ type: "committed", text: text(transcript), words });
	partial = "";
	// A started stream begins from nothing, its time included.
	stream.start();
}

/** Messages wait for the model, then go in order. */
let queue: Promise<void> = Promise.resolve();
self.onmessage = ({ data }: MessageEvent<ToMoonshine>) => {
	queue = queue
		.then(() => loaded)
		.then((stream) => handle(stream, data))
		.catch((error: Error) =>
			post({ type: "failed", error: String(error.message ?? error) }),
		);
};
