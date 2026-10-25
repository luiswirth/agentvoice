// The person's side of a scenario as audio: each part said by ElevenLabs in
// a voice other than the speaker's, with the scenario's silences between, as
// one WAV for Chromium's fake microphone.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Scenario } from "./scenarios.ts";

export const RATE = 48_000;

/** A voice of ElevenLabs' own library, so that every account has it. */
const PERSON = "JBFqnCBsd6RMkjVDRZzb";
const MODEL = "eleven_multilingual_v2";

const cache = join(import.meta.dirname, ".cache");

/** Where each turn's speech ends, in seconds into the audio. */
export type Timeline = { start: number; end: number }[];

/** The scenario's audio, written to a WAV, and when each turn is said. */
export async function speech(
	scenario: Scenario,
	key: string,
): Promise<{ wav: string; timeline: Timeline; duration: number }> {
	await mkdir(cache, { recursive: true });
	const chunks: Int16Array[] = [];
	const timeline: Timeline = [];
	let at = 0;
	const silence = (seconds: number) => {
		const samples = new Int16Array(Math.round(seconds * RATE));
		chunks.push(samples);
		at += samples.length / RATE;
	};
	silence(scenario.lead ?? 1);
	for (const turn of scenario.turns) {
		const start = at;
		// Parts are said one by one, so a pause inside a turn is exact.
		for (const [i, part] of turn.parts.entries()) {
			if (i > 0) silence(turn.pause ?? 1);
			const samples = trim(await said(part, key));
			chunks.push(samples);
			at += samples.length / RATE;
		}
		timeline.push({ start, end: at });
		silence(turn.after ?? 4);
	}
	const wav = join(cache, `${scenario.name}.wav`);
	await writeFile(wav, wave(chunks));
	return { wav, timeline, duration: at };
}

/** A part said, from the cache once it was said before. */
async function said(text: string, key: string): Promise<Int16Array> {
	const id = createHash("sha256")
		.update(`${PERSON} ${MODEL} ${text}`)
		.digest("hex")
		.slice(0, 16);
	const file = join(cache, `${id}.pcm`);
	const kept = await readFile(file).catch(() => null);
	if (kept)
		return new Int16Array(kept.buffer, kept.byteOffset, kept.length / 2);
	const response = await fetch(
		`https://api.elevenlabs.io/v1/text-to-speech/${PERSON}?output_format=pcm_${RATE}`,
		{
			method: "POST",
			headers: { "xi-api-key": key, "content-type": "application/json" },
			body: JSON.stringify({ text, model_id: MODEL }),
		},
	);
	if (!response.ok)
		throw new Error(`ElevenLabs ${response.status}: ${await response.text()}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	await writeFile(file, bytes);
	return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length >> 1);
}

/** Without the silence ElevenLabs puts around speech, so that the scenario's
 * timeline holds where the speech is. */
function trim(samples: Int16Array): Int16Array {
	const loud = (s: number) => Math.abs(s) > 300;
	let first = samples.findIndex(loud);
	if (first < 0) return new Int16Array(0);
	let last = samples.findLastIndex(loud);
	first = Math.max(0, first - RATE / 100);
	last = Math.min(samples.length, last + RATE / 100);
	return samples.slice(first, last);
}

function wave(chunks: Int16Array[]): Uint8Array {
	const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const bytes = new Uint8Array(44 + 2 * length);
	const view = new DataView(bytes.buffer);
	const text = (at: number, s: string) => {
		for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
	};
	text(0, "RIFF");
	view.setUint32(4, 36 + 2 * length, true);
	text(8, "WAVEfmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, RATE, true);
	view.setUint32(28, 2 * RATE, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	text(36, "data");
	view.setUint32(40, 2 * length, true);
	let at = 44;
	for (const chunk of chunks)
		for (const sample of chunk) {
			view.setInt16(at, sample, true);
			at += 2;
		}
	return bytes;
}
