// The clips the model bench hears: read speech with its transcript, German
// from Multilingual LibriSpeech and English from LibriSpeech, both CC BY 4.0,
// fetched once through Hugging Face's dataset viewer and decoded to 16 kHz
// mono float32, as the models take it.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type Clip = {
	name: string;
	language: "de" | "en";
	text: string;
	seconds: number;
};

const SOURCES = [
	{
		language: "de",
		dataset: "facebook/multilingual_librispeech",
		config: "german",
		text: "transcript",
	},
	{
		language: "en",
		dataset: "openslr/librispeech_asr",
		config: "clean",
		text: "text",
	},
] as const;

/** Clips per language. */
const COUNT = 8;
/** Long enough to measure speed, short enough for a turn. */
const SECONDS = { min: 4, max: 16 };

/** The clips in `directory`, fetched there first if missing. */
export async function clips(directory: string): Promise<Clip[]> {
	const index = join(directory, "clips.json");
	try {
		return JSON.parse(await readFile(index, "utf8"));
	} catch {}
	await mkdir(directory, { recursive: true });
	const all: Clip[] = [];
	for (const source of SOURCES) {
		const url = `https://datasets-server.huggingface.co/rows?dataset=${source.dataset}&config=${source.config}&split=test&offset=0&length=60`;
		const response = await fetch(url);
		if (!response.ok) throw new Error(`${url}: ${response.status}`);
		const { rows } = (await response.json()) as {
			rows: { row: Record<string, unknown> }[];
		};
		let n = 0;
		for (const { row } of rows) {
			if (n === COUNT) break;
			const audio = (row.audio as { src: string }[])[0];
			if (audio === undefined) continue;
			const encoded = Buffer.from(await (await fetch(audio.src)).arrayBuffer());
			const pcm = execFileSync(
				"ffmpeg",
				[
					"-v",
					"error",
					"-i",
					"pipe:0",
					"-ac",
					"1",
					"-ar",
					"16000",
					"-f",
					"f32le",
					"pipe:1",
				],
				{ input: encoded, maxBuffer: 1 << 28 },
			);
			const seconds = pcm.length / 4 / 16_000;
			if (seconds < SECONDS.min || seconds > SECONDS.max) continue;
			const name = `${source.language}-${String(n).padStart(2, "0")}`;
			await writeFile(join(directory, `${name}.f32`), pcm);
			all.push({
				name,
				language: source.language,
				text: String(row[source.text]),
				seconds,
			});
			n++;
		}
	}
	await writeFile(index, JSON.stringify(all, null, "\t"));
	return all;
}
