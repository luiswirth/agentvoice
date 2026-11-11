// Streams a 16 kHz mono WAV to Scribe in real time and keeps every message
// it answers with, timed in seconds of the audio, into bench/.cache/scribe/.
//   pnpm exec tsx bench/scribe-probe.ts <wav> <model> [query...]
// such as `scribe_v3_live commit_strategy=turn_prediction diarize=true`.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const [wav, model, ...extra] = process.argv.slice(2);
if (!wav || !model)
	throw new Error("usage: scribe-probe <wav> <model> [k=v...]");
const key = (
	await readFile(join(homedir(), "secrets/elevenlabs-api-key.txt"), "utf8")
).trim();
const bytes = await readFile(wav);
const pcm = new Int16Array(
	bytes.buffer,
	bytes.byteOffset + 44,
	(bytes.length - 44) / 2,
);
const token = (
	(await (
		await fetch(
			"https://api.elevenlabs.io/v1/single-use-token/realtime_scribe",
			{
				method: "POST",
				headers: { "xi-api-key": key },
			},
		)
	).json()) as { token: string }
).token;
const query = new URLSearchParams({
	model_id: model,
	token,
	audio_format: "pcm_16000",
	include_timestamps: "true",
});
for (const kv of extra) {
	const [k, v] = kv.split("=");
	query.append(k ?? "", v ?? "");
}
const socket = new WebSocket(
	`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${query}`,
);
const messages: unknown[] = [];
const t0 = performance.now();
const now = () => (performance.now() - t0) / 1000;
socket.addEventListener("message", ({ data }) => {
	const m = JSON.parse(String(data));
	messages.push({ t: now(), ...m });
	if (m.message_type !== "partial_transcript")
		console.log(now().toFixed(2), m.message_type, m.text ?? m.error ?? "");
});
const closed = new Promise<void>((resolve) =>
	socket.addEventListener("close", (e) => {
		console.log("closed", e.code, e.reason);
		resolve();
	}),
);
await new Promise((r) => socket.addEventListener("open", r, { once: true }));
const CHUNK = 1600;
for (let i = 0; i < pcm.length; i += CHUNK) {
	const chunk = pcm.slice(i, i + CHUNK);
	socket.send(
		JSON.stringify({
			message_type: "input_audio_chunk",
			audio_base_64: Buffer.from(chunk.buffer).toString("base64"),
			commit: false,
			sample_rate: 16000,
		}),
	);
	const due = (i + CHUNK) / 16000;
	await new Promise((r) => setTimeout(r, Math.max(0, (due - now()) * 1000)));
}
socket.send(
	JSON.stringify({
		message_type: "input_audio_chunk",
		audio_base_64: "",
		commit: true,
		sample_rate: 16000,
	}),
);
await new Promise((r) => setTimeout(r, 5000));
socket.close(1000);
await closed;
const out = join(
	import.meta.dirname,
	".cache/scribe",
	`${basename(dirname(wav))}-${model}${extra.length ? `-${extra.join("-")}` : ""}.json`,
);
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(messages));
console.log(out);
