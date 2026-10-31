// Joins the audio a page shared into a session into one recording, its
// stretches at their times and silence between, for `just bench` to replay.
//
//   just recording <session link> [out.wav]
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { type Entry, Session } from "polylogue/participant";

const RATE = 16_000;

/** The stretches the page shared into `session` as one WAV, and when its
 * first sample was heard, in ms since the epoch. */
export async function joined(
	session: Session,
): Promise<{ wav: Uint8Array; start: number }> {
	const stretches = session.log.filter(
		(entry: Entry) =>
			entry.type.startsWith("audio/wav") &&
			entry.filename?.startsWith("heard "),
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
		const at = Math.round(
			((start(entry.filename ?? "") - first) / 1000) * RATE,
		);
		pieces.push({ at, pcm });
		console.log(`${entry.filename}: ${(pcm.length / RATE).toFixed(1)} s`);
	}
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
	const wav = new Uint8Array(44 + 2 * length);
	wav.set(new Uint8Array(header.buffer), 0);
	wav.set(new Uint8Array(samples.buffer), 44);
	return { wav, start: first };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const [link, out = "recording.wav"] = process.argv.slice(2);
	if (!link) throw new Error("usage: recording.ts <session link> [out.wav]");
	const session = new Session(link, `bench-${Date.now()}`);
	await session.join();
	// The log so far arrives right after joining.
	await new Promise((resolve) => setTimeout(resolve, 3000));
	const { wav } = await joined(session);
	await session.leave();
	await writeFile(out, wav);
	console.log(`${out}: ${((wav.length - 44) / 2 / RATE).toFixed(1)} s`);
}
