// The page's cues as one WAV to listen to, into bench/.cache/sounds.wav:
// a conversation's course first, then each cue alone, a second apart, in the
// order of `alone` below.
//
//   just sounds
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "vite";

/** A conversation: the person turns listening on, starts speaking, sends; the agent
 * reads it, works, sends a file, works on, and answers in two messages,
 * the cue between them. */
const course: [number, string][] = [
	[0, "listen"],
	[1.5, "speaking"],
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
	"speaking",
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
const server = await createServer({ server: { port: 0 }, logLevel: "silent" });
await server.listen();
const url = server.resolvedUrls?.local[0];
const browser = await chromium.launch({
	executablePath: process.env.CHROMIUM ?? "",
});
try {
	const tab = await browser.newPage();
	await tab.goto(`${url}index.html`);
	const samples: number[] = await tab.evaluate(
		async ({ course, alone, length }) => {
			// The page's own module, as the dev server serves it.
			const path: string = "/src/voice/sounds.ts";
			const { schedule } = (await import(
				/* @vite-ignore */ path
			)) as typeof import("../src/voice/sounds.ts");
			const rate = 48000;
			const audio = new OfflineAudioContext(1, rate * length, rate);
			for (const [at, cue] of course) schedule(audio, cue as never, at);
			alone.forEach((cue, i) => {
				schedule(audio, cue as never, 16 + i);
			});
			return Array.from((await audio.startRendering()).getChannelData(0));
		},
		{ course, alone, length },
	);
	const peak = samples.reduce((max, s) => Math.max(max, Math.abs(s)), 0);
	console.log(`peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS`);
	await writeFile(join(out, "sounds.wav"), wav(samples, 48000));
	console.log(join(out, "sounds.wav"));
} finally {
	await browser.close();
	await server.close();
}

function wav(samples: number[], rate: number): Buffer {
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
