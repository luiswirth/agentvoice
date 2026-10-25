// Joins the audio a page shared into a session into one recording, its
// stretches at their times and silence between, for `just bench` to replay.
//
//   just recording <session link> [out.wav]
import { writeFile } from "node:fs/promises";
import { Session } from "byoa/participant";

const [link, out = "recording.wav"] = process.argv.slice(2);
if (!link) throw new Error("usage: recording.ts <session link> [out.wav]");

const RATE = 16_000;
const session = new Session(link, `bench-${Date.now()}`);
await session.join();
// The log so far arrives right after joining.
await new Promise((resolve) => setTimeout(resolve, 3000));
const stretches = session.log.filter(
	(entry) =>
		entry.type.startsWith("audio/wav") && entry.filename?.startsWith("heard "),
);
if (stretches.length === 0) throw new Error("the session holds no audio");
const start = (filename: string) =>
	Date.parse(filename.slice("heard ".length, -".wav".length));
const first = start(stretches[0]?.filename ?? "");
const pieces: { at: number; pcm: Int16Array }[] = [];
for (const entry of stretches) {
	const bytes = new Uint8Array(
		await (await session.fetch(entry.n)).arrayBuffer(),
	);
	const pcm = new Int16Array(bytes.slice(44).buffer);
	const at = Math.round(((start(entry.filename ?? "") - first) / 1000) * RATE);
	pieces.push({ at, pcm });
	console.log(`${entry.filename}: ${(pcm.length / RATE).toFixed(1)} s`);
}
await session.leave();
const length = Math.max(...pieces.map(({ at, pcm }) => at + pcm.length));
const samples = new Int16Array(length);
for (const { at, pcm } of pieces) samples.set(pcm, Math.max(0, at));
const header = new DataView(new ArrayBuffer(44));
const text = (at: number, s: string) => {
	for (let i = 0; i < s.length; i++) header.setUint8(at + i, s.charCodeAt(i));
};
text(0, "RIFF");
header.setUint32(4, 36 + 2 * length, true);
text(8, "WAVEfmt ");
header.setUint32(16, 16, true);
header.setUint16(20, 1, true);
header.setUint16(22, 1, true);
header.setUint32(24, RATE, true);
header.setUint32(28, 2 * RATE, true);
header.setUint16(32, 2, true);
header.setUint16(34, 16, true);
text(36, "data");
header.setUint32(40, 2 * length, true);
await writeFile(
	out,
	Buffer.concat([
		Buffer.from(header.buffer),
		Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength),
	]),
);
console.log(`${out}: ${(length / RATE).toFixed(1)} s`);
