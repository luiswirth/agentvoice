// The model bench: builds the page of `page.ts`, serves it on this machine at
// 127.0.0.1:5180, cross-origin isolated so that threads run, which the tailnet
// reaches at :8445 over HTTPS, and drives Safari on the Mac or the iPhone
// through WebDriver to load each candidate there twice, once as a person
// first opens it and once from the browser's cache.
//
//   just bench-models [mac|iphone] [candidate...]
//
// Safari Technology Preview on the Mac, never the person's own Safari: its
// driver replaces the saved session. The iPhone needs its cable to the Mac
// and Settings → Safari → Advanced → Remote Automation.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build, type Plugin, preview } from "vite";
import { candidates } from "./candidates.ts";
import { type Clip, clips } from "./clips.ts";
import type { Report } from "./page.ts";

const ROOT = import.meta.dirname;
const CACHE = join(ROOT, "../.cache/models");
const PORT = 5180;
const HOST = "lwirth-server.taile6c58a.ts.net";
const PAGE = `https://${HOST}:8445/`;
const MAC = "lwirth-macbook";
const DRIVER_PORT = 4445;
/** How long one candidate may take, downloads included. */
const PATIENCE = 15 * 60_000;

const [device = "mac", ...asked] = process.argv.slice(2);
const DEVICES = {
	mac: {
		driver:
			"/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver",
		capabilities: { browserName: "Safari Technology Preview" },
	},
	iphone: {
		driver: "/usr/bin/safaridriver",
		capabilities: { browserName: "Safari", platformName: "iOS" },
	},
};
const target = DEVICES[device as keyof typeof DEVICES];
if (target === undefined) throw new Error(`no device ${device}: mac or iphone`);
const names = asked.length > 0 ? asked : Object.keys(candidates);
// `clear` alone only empties what earlier runs stored in the browser.
for (const name of names)
	if (!(name in candidates) && name !== "clear")
		throw new Error(`no candidate ${name}`);

const all = await clips(join(CACHE, "clips"));
const run = join(
	CACHE,
	"runs",
	`${new Date().toISOString().replaceAll(":", "")}-${device}`,
);
await mkdir(run, { recursive: true });

// The page posts each report here; the bench waits for the next one.
let reported: (report: Report) => void = () => {};
const bench: Plugin = {
	name: "model-bench",
	configurePreviewServer(server) {
		server.middlewares.use(async (request, response, next) => {
			const url = new URL(request.url ?? "/", "http://bench");
			const path = url.pathname.replace(
				/^.*?\/(clips|report|audio|log)/,
				"/$1",
			);
			if (request.method === "GET" && path.startsWith("/clips/")) {
				const file = path.slice("/clips/".length);
				if (!/^[\w.-]+$/.test(file)) return next();
				response.setHeader("Content-Type", "application/octet-stream");
				response.end(await readFile(join(CACHE, "clips", file)));
			} else if (
				request.method === "POST" &&
				(path === "/report" || path === "/audio" || path === "/log")
			) {
				const body = await read(request);
				if (path === "/report") reported(JSON.parse(body.toString()));
				else if (path === "/log") console.error(`  ${body.toString()}`);
				else {
					const q = url.searchParams;
					const pcm = new Float32Array(
						body.buffer,
						body.byteOffset,
						body.length / 4,
					);
					await writeFile(
						join(
							run,
							`${q.get("candidate")}-${q.get("pass")}-${q.get("n")}.wav`,
						),
						wav(pcm, Number(q.get("rate"))),
					);
				}
				response.end();
			} else next();
		});
	},
};

const config = {
	configFile: false as const,
	root: ROOT,
	base: "./",
	logLevel: "warn" as const,
	build: { outDir: join(CACHE, "dist"), emptyOutDir: true, target: "esnext" },
	worker: { format: "es" as const },
	plugins: [bench],
	preview: {
		host: "127.0.0.1",
		port: PORT,
		strictPort: true,
		allowedHosts: [HOST],
		headers: {
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cross-Origin-Embedder-Policy": "require-corp",
		},
	},
};
await build(config);
const server = await preview(config);

// safaridriver listens on the Mac's loopback only, so ssh carries it here; a
// terminal on the Mac's side ends it with the connection.
const driver: ChildProcess = spawn(
	"ssh",
	[
		"-tt",
		"-L",
		`${DRIVER_PORT}:127.0.0.1:${DRIVER_PORT}`,
		MAC,
		`exec '${target.driver}' -p ${DRIVER_PORT}`,
	],
	{ stdio: ["pipe", "inherit", "inherit"] },
);
const WD = `http://127.0.0.1:${DRIVER_PORT}`;

const reports: Report[] = [];
let session: string | undefined;
try {
	await until(async () => (await fetch(`${WD}/status`)).ok, 30_000);
	// Each candidate loads first into an emptied browser, as a person first
	// opens it, then from what that load stored; the bench leaves it empty.
	for (const name of names) {
		if (name === "clear") continue;
		await open("clear", "before");
		for (const pass of ["first", "cached"]) {
			reports.push(await open(name, pass));
			// Kept as it comes, since a crash may take the bench down.
			await writeFile(
				join(run, "reports.json"),
				JSON.stringify(reports, null, "\t"),
			);
		}
	}
	await open("clear", "after");
} catch (error) {
	console.error(`The bench stopped: ${(error as Error).message}`);
} finally {
	if (session !== undefined)
		await webdriver("DELETE", `/session/${session}`).catch(() => {});
	driver.kill();
	await server.close();
}

await writeFile(join(run, "reports.json"), JSON.stringify(reports, null, "\t"));
console.log(summary(reports, all));
console.log(`\nReports and audio in ${run}`);
process.exit(0);

/** Opens the page on a candidate, in a new session where the last one ended,
 * and waits for its report, or for the page to crash, which ends the session. */
async function open(name: string, pass: string): Promise<Report> {
	console.error(`${name}, ${pass}`);
	session ??= (
		(await webdriver("POST", "/session", {
			capabilities: { alwaysMatch: target.capabilities },
		})) as { sessionId: string }
	).sessionId;
	const id = session;
	let watch: NodeJS.Timeout | undefined;
	const report = new Promise<Report>((resolve, reject) => {
		reported = resolve;
		setTimeout(() => reject(new Error("timed out")), PATIENCE);
		watch = setInterval(() => {
			webdriver("GET", `/session/${id}/url`).catch((error: Error) => {
				if (!error.message.includes("invalid session id")) return;
				session = undefined;
				reject(new Error("the page crashed, and its session with it"));
			});
		}, 10_000);
	});
	await webdriver("POST", `/session/${id}/url`, {
		url: `${PAGE}?candidate=${name}&pass=${pass}`,
	});
	return report
		.catch((error: Error) => ({
			candidate: name,
			pass,
			browser: { userAgent: "" } as Report["browser"],
			error: error.message,
		}))
		.finally(() => clearInterval(watch));
}

async function webdriver(
	method: string,
	path: string,
	body?: unknown,
): Promise<unknown> {
	const response = await fetch(`${WD}${path}`, {
		method,
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? null : JSON.stringify(body),
	});
	const { value } = (await response.json()) as { value: unknown };
	if (!response.ok)
		throw new Error(`WebDriver ${method} ${path}: ${JSON.stringify(value)}`);
	return value;
}

async function until(ready: () => Promise<boolean>, ms: number) {
	const end = Date.now() + ms;
	for (;;) {
		if (await ready().catch(() => false)) return;
		if (Date.now() > end) throw new Error("safaridriver did not start");
		await new Promise((r) => setTimeout(r, 500));
	}
}

function read(request: NodeJS.ReadableStream): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => resolve(Buffer.concat(chunks)));
		request.on("error", reject);
	});
}

/** 16-bit mono WAV. */
function wav(pcm: Float32Array, rate: number): Buffer {
	const out = Buffer.alloc(44 + pcm.length * 2);
	out.write("RIFF", 0);
	out.writeUInt32LE(36 + pcm.length * 2, 4);
	out.write("WAVEfmt ", 8);
	out.writeUInt32LE(16, 16);
	out.writeUInt16LE(1, 20);
	out.writeUInt16LE(1, 22);
	out.writeUInt32LE(rate, 24);
	out.writeUInt32LE(rate * 2, 28);
	out.writeUInt16LE(2, 32);
	out.writeUInt16LE(16, 34);
	out.write("data", 36);
	out.writeUInt32LE(pcm.length * 2, 40);
	for (const [i, x] of pcm.entries())
		out.writeInt16LE(
			Math.round(Math.max(-1, Math.min(1, x)) * 32767),
			44 + i * 2,
		);
	return out;
}

/** Word error rate: word edits from the reference, over its words. */
function wer(reference: string, heard: string): number {
	const words = (s: string) =>
		s
			.toLowerCase()
			.normalize("NFC")
			.replace(/[^\p{L}\p{N}' ]+/gu, " ")
			.split(/\s+/)
			.filter(Boolean);
	const r = words(reference);
	const h = words(heard);
	let previous = Array.from({ length: h.length + 1 }, (_, j) => j);
	for (const [i, rw] of r.entries()) {
		const current = [i + 1];
		for (const [j, hw] of h.entries())
			current.push(
				Math.min(
					(previous[j + 1] as number) + 1,
					(current[j] as number) + 1,
					(previous[j] as number) + (rw === hw ? 0 : 1),
				),
			);
		previous = current;
	}
	return (previous[h.length] as number) / Math.max(1, r.length);
}

function summary(reports: Report[], all: Clip[]): string {
	const browser = reports.find((r) => r.browser.userAgent)?.browser;
	const lines = [
		`browser: ${browser?.userAgent}`,
		`isolated: ${browser?.crossOriginIsolated}, WebGPU: ${browser?.webgpu}`,
		"",
	];
	const byClip = new Map(all.map((clip) => [clip.name, clip]));
	for (const r of reports) {
		const head = `${r.candidate} (${r.pass})`;
		const load = r.load
			? `load ${(r.load.ms / 1000).toFixed(1)} s, stored ${(r.load.stored / 1e6).toFixed(0)} MB`
			: "";
		const parts = [head, load];
		if (r.heard && r.heard.length > 0) {
			for (const language of ["de", "en"]) {
				const heard = r.heard.filter(
					(h) => byClip.get(h.clip)?.language === language,
				);
				if (heard.length === 0) continue;
				let errors = 0;
				let words = 0;
				let ms = 0;
				let seconds = 0;
				for (const h of heard) {
					const clip = byClip.get(h.clip) as Clip;
					const n = clip.text.split(/\s+/).length;
					errors += wer(clip.text, h.text) * n;
					words += n;
					ms += h.ms;
					seconds += clip.seconds;
				}
				parts.push(
					`${language}: WER ${((100 * errors) / words).toFixed(1)}%, ${(seconds / (ms / 1000)).toFixed(1)}x real time`,
				);
			}
		}
		if (r.spoken)
			for (const s of r.spoken)
				parts.push(
					`"${s.text.slice(0, 24)}": first audio ${s.firstMs.toFixed(0)} ms, ${(s.seconds / (s.ms / 1000)).toFixed(1)}x real time`,
				);
		if (r.load?.info) parts.push(r.load.info);
		if (r.error) parts.push(`ERROR ${r.error.split("\n")[0]}`);
		lines.push(parts.filter(Boolean).join("\n  "));
	}
	return lines.join("\n");
}
