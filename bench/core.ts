// The core alone, in Node, as a host other than the page has it: a
// scenario's speech is heard in real time, Scribe transcribes, and the
// reflexes run in this process, behind ports. It prints each turn the core
// ends, and when, against when it was said.
//
//   just core [scenario]
//
// It uses the ElevenLabs key in ~/secrets/elevenlabs-api-key.txt.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as ort from "onnxruntime-web/wasm";
import {
	Conversation,
	type Model,
	type Port,
	REDIMNET2,
	SILERO,
	SMART_TURN,
	serveFingerprints,
	serveTurns,
} from "voice-core";
import { Scribe } from "../src/voice/elevenlabs.ts";
import { scenarios } from "./scenarios.ts";
import { RATE, speech } from "./speech.ts";

const name = process.argv[2] ?? "turns";
const scenario = scenarios.find((s) => s.name === name);
if (scenario === undefined) throw new Error(`no scenario ${name}`);
const key = (
	await readFile(join(homedir(), "secrets/elevenlabs-api-key.txt"), "utf8")
).trim();
const { wav, timeline, duration } = await speech(scenario, key);

/** A model's bytes, fetched once into the bench's cache. */
const cache = join(import.meta.dirname, ".cache", "models");
async function model({ url, integrity }: Model): Promise<Uint8Array> {
	const file = join(cache, integrity.replace(/[^\w]/g, ""));
	try {
		return new Uint8Array(await readFile(file));
	} catch {}
	const source = url.startsWith("http")
		? new Uint8Array(await (await fetch(url, { integrity })).arrayBuffer())
		: new Uint8Array(
				await readFile(join(import.meta.dirname, "../public", url)),
			);
	await mkdir(cache, { recursive: true });
	await writeFile(file, source);
	return source;
}

/** Two ends of a channel in this process, each delivering as a worker
 * would, after the current task. */
function channel<A, B>(): [Port<A, B>, Port<B, A>] {
	const handlers: { a?: (m: B) => void; b?: (m: A) => void } = {};
	return [
		{
			post: (m) => setImmediate(() => handlers.b?.(m)),
			receive: (message) => {
				handlers.a = message;
			},
			close: () => {},
		},
		{
			post: (m) => setImmediate(() => handlers.a?.(m)),
			receive: (message) => {
				handlers.b = message;
			},
			close: () => {},
		},
	];
}

ort.env.wasm.numThreads = 1;

const start = performance.now();
const at = () => ((performance.now() - start) / 1000).toFixed(2);
const conversation = new Conversation({
	transcribe: (heard) => Scribe.open(key, heard, []),
	reflexes: {
		turns: () => {
			const [core, host] = channel<never, never>();
			serveTurns(host, Promise.all([model(SILERO), model(SMART_TURN)]));
			return core;
		},
		fingerprints: () => {
			const [core, host] = channel<never, never>();
			serveFingerprints(host, model(REDIMNET2));
			return core;
		},
	},
	listener: true,
	sounds: false,
});
conversation.on("turn", ({ text }) => console.log(`${at()} s: ${text}`));
conversation.on("error", (error) => error && console.error(error.message));
await new Promise<void>((resolve) => {
	const off = conversation.on("state", ({ listener }) => {
		if (!listener) return;
		off();
		resolve();
	});
});

// The scenario's WAV, 16-bit mono at `RATE`, heard 10 ms at a time.
const samples = new Int16Array((await readFile(wav)).buffer.slice(44));
const step = RATE / 100;
const heard = performance.now();
for (let i = 0; i < samples.length; i += step) {
	const chunk = Float32Array.from(
		samples.subarray(i, i + step),
		(s) => s / 32768,
	);
	conversation.hear(chunk, RATE);
	const due = heard + ((i + step) / RATE) * 1000;
	await new Promise((resolve) =>
		setTimeout(resolve, Math.max(0, due - performance.now())),
	);
}
await new Promise((resolve) => setTimeout(resolve, 3000));
const offset = (heard - start) / 1000;
for (const { end } of timeline)
	console.log(`said until ${(offset + end).toFixed(2)} s`);
console.log(`heard ${duration.toFixed(1)} s`);
conversation.close();
process.exit(0);
