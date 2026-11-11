// The core alone, in Node, as a host other than the page has it: a
// scenario's speech is heard in real time, through Scribe. It prints each
// turn the core ends, and when, against when it was said.
//
//   just core [scenario]
//
// It uses the ElevenLabs key in ~/secrets/elevenlabs-api-key.txt.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Conversation } from "voice-core";
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

const start = performance.now();
const at = () => ((performance.now() - start) / 1000).toFixed(2);
const conversation = new Conversation({
	listen: (perception) => Scribe.open(key, perception, []),
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
