// Joins the audio a page shared into a session into one recording, its
// stretches at their times and silence between, for `just bench` to replay.
//
//   just recording <session link> [out.wav]
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { type Entry, Session } from "polylogue/participant";
import { LISTEN_RATE as RATE } from "../src/voice/engines.ts";
import { type Piece, recording } from "../src/voice/trace.ts";

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
	const pieces: Piece[] = [];
	for (const entry of stretches) {
		const bytes = new Uint8Array(
			await (await session.fetch(entry.n)).arrayBuffer(),
		);
		const pcm = new Int16Array(bytes.slice(44).buffer);
		const filename = entry.filename ?? "";
		pieces.push({
			start: Date.parse(filename.slice("heard ".length, -".wav".length)),
			pcm,
		});
		console.log(`${entry.filename}: ${(pcm.length / RATE).toFixed(1)} s`);
	}
	const { wav, start } = recording(pieces);
	return { wav: new Uint8Array(await wav.arrayBuffer()), start };
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
