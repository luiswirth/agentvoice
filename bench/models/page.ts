// The model bench's page: loads the candidate named in its query, runs it on
// the clips or the sentences, and posts what it measured to the server that
// serves it, which `run.ts` reads.

import { candidates, sentences } from "./candidates.ts";
import type { Clip } from "./clips.ts";

export type Report = {
	candidate: string;
	pass: string;
	browser: {
		userAgent: string;
		crossOriginIsolated: boolean;
		webgpu: string;
		cores: number;
	};
	load?: {
		ms: number;
		stored: number;
		info?: string | undefined;
	};
	heard?: { clip: string; ms: number; text: string }[];
	spoken?: { text: string; firstMs: number; ms: number; seconds: number }[];
	error?: string;
};

const log = document.getElementById("log") as HTMLElement;
const say = (line: string) => {
	log.textContent += `${line}\n`;
	void fetch("./log", {
		method: "POST",
		body: `${name}: ${line.slice(0, 300)}`,
	});
};

const query = new URLSearchParams(location.search);
const name = query.get("candidate") ?? "";
const report: Report = {
	candidate: name,
	pass: query.get("pass") ?? "",
	browser: {
		userAgent: navigator.userAgent,
		crossOriginIsolated,
		webgpu: await webgpu(),
		cores: navigator.hardwareConcurrency,
	},
};

let posted = false;
async function post(error?: unknown) {
	if (posted) return;
	posted = true;
	if (error !== undefined)
		report.error =
			error instanceof Error
				? `${error.name}: ${error.message}\n${error.stack ?? ""}`
				: String(error);
	say(JSON.stringify(report, null, 2));
	await fetch("./report", { method: "POST", body: JSON.stringify(report) });
}
addEventListener("error", (event) => void post(event.error ?? event.message));
addEventListener("unhandledrejection", (event) => void post(event.reason));

try {
	await run();
	await post();
} catch (error) {
	await post(error);
}

async function run() {
	const candidate = candidates[name];
	if (candidate === undefined) throw new Error(`no candidate ${name}`);
	if (name === "clear") return clear();
	const stored = await usage();
	const start = performance.now();
	say(`loading ${name}`);
	if (candidate.kind === "hearing") {
		const hear = await candidate.load();
		report.load = await loaded(start, stored);
		const clips = (
			(await (await fetch("./clips/clips.json")).json()) as Clip[]
		).filter((clip) => candidate.languages.includes(clip.language));
		report.heard = [];
		for (const clip of clips) {
			const pcm = new Float32Array(
				await (await fetch(`./clips/${clip.name}.f32`)).arrayBuffer(),
			);
			const t = performance.now();
			const text = await hear(pcm);
			report.heard.push({ clip: clip.name, ms: performance.now() - t, text });
			say(`${clip.name}: ${text}`);
		}
	} else {
		const voice = await candidate.load();
		report.load = { ...(await loaded(start, stored)), info: voice.info };
		report.spoken = [];
		for (const [i, text] of sentences[candidate.language].entries()) {
			const chunks: Float32Array[] = [];
			const t = performance.now();
			let firstMs = Number.NaN;
			for await (const chunk of voice.speak(text)) {
				if (chunks.length === 0) firstMs = performance.now() - t;
				chunks.push(chunk);
			}
			const ms = performance.now() - t;
			const audio = join(chunks);
			report.spoken.push({
				text,
				firstMs,
				ms,
				seconds: audio.length / voice.sampleRate,
			});
			await fetch(
				`./audio?candidate=${name}&pass=${report.pass}&n=${i}&rate=${voice.sampleRate}`,
				{
					method: "POST",
					body: audio.buffer as ArrayBuffer,
				},
			);
			say(`spoke ${text}`);
		}
	}
}

/** The load's time, and what it stored in the browser, as the browser counts
 * it: the packages cache their downloads, each its own way. */
async function loaded(start: number, stored: number) {
	const ms = performance.now() - start;
	return { ms, stored: (await usage()) - stored };
}

async function usage(): Promise<number> {
	return (await navigator.storage.estimate()).usage ?? 0;
}

/** Empties what the page's origin stored, so the next load starts as a
 * person's first. */
async function clear() {
	for (const key of await caches.keys()) await caches.delete(key);
	for (const db of await indexedDB.databases())
		if (db.name !== undefined) indexedDB.deleteDatabase(db.name);
	const root = await navigator.storage.getDirectory();
	for await (const [entry] of root as unknown as AsyncIterable<[string]>)
		await root.removeEntry(entry, { recursive: true });
	report.load = { ms: 0, stored: await usage() };
}

function join(chunks: Float32Array[]): Float32Array {
	const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
	let at = 0;
	for (const chunk of chunks) {
		all.set(chunk, at);
		at += chunk.length;
	}
	return all;
}

async function webgpu(): Promise<string> {
	const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } })
		.gpu;
	if (gpu === undefined) return "none";
	const adapter = (await gpu.requestAdapter()) as {
		features: Set<string>;
		limits: { maxBufferSize: number };
	} | null;
	if (adapter === null) return "no adapter";
	return `f16 ${adapter.features.has("shader-f16")}, max buffer ${adapter.limits.maxBufferSize / 2 ** 20} MiB`;
}
