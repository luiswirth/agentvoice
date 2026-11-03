// The page's cues as one WAV to listen to, into bench/.cache/sounds.wav:
// a conversation's course first, then each cue alone, a second apart, in the
// order of `alone` below.
//
//   just sounds
//
// It renders them with the core, as any host plays them.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Cue, Cues } from "voice-core";

/** A conversation: the person turns listening on, speaks, sends; the agent
 * reads it, works, sends a file, works on, and answers in two messages,
 * the cue between them. */
const course: [number, string][] = [
	[0, "listen"],
	[3, "sent"],
	[4, "read"],
	[6.2, "working"],
	[8, "other"],
	[11, "working"],
	[14.5, "next"],
];
const alone = [
	"press",
	"listen",
	"unlisten",
	"speak",
	"unspeak",
	"sent",
	"dropped",
	"read",
	"working",
	"other",
	"message",
	"next",
	"joined",
	"left",
	"problem",
];
const length = 16 + alone.length + 1;

const out = join(import.meta.dirname, ".cache");
await mkdir(out, { recursive: true });
// The core's cues, rendered as a host plays them, a block at a time, each
// cue asked for as its block starts.
const rate = 48000;
const block = rate / 100;
const cues = new Cues();
const asked = [
	...course,
	...alone.map((cue, i): [number, string] => [16 + i, cue]),
].sort(([a], [b]) => a - b);
const samples = new Float32Array(rate * length);
for (let at = 0; at < samples.length; at += block) {
	while (asked[0] !== undefined && asked[0][0] * rate < at + block)
		cues.ask(asked.shift()?.[1] as Cue);
	cues.render(samples.subarray(at, at + block), rate);
}
const peak = samples.reduce((max, s) => Math.max(max, Math.abs(s)), 0);
console.log(`peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS`);
await writeFile(join(out, "sounds.wav"), wav(samples, rate));
console.log(join(out, "sounds.wav"));

function wav(samples: Float32Array, rate: number): Buffer {
	const data = Buffer.alloc(samples.length * 2);
	samples.forEach((s, i) => {
		data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2);
	});
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVEfmt ", 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(rate, 24);
	header.writeUInt32LE(rate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}
