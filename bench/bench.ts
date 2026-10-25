// The test bench: plays a scenario's speech into the real page, built from
// this checkout, through Chromium's fake microphone, with a fake agent in the
// session, and measures from the page's trace how the turns reached the agent.
//
//   just bench [scenario]
//
// It uses the ElevenLabs key in ~/secrets/elevenlabs-api-key.txt and the
// public relay.
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { create, type Entry, Session } from "byoa/participant";
import { chromium } from "playwright-core";
import { preview } from "vite";
import { scenarios } from "./scenarios.ts";
import { speech, type Timeline } from "./speech.ts";

const RELAY = "https://byoa.senses.sh";
const TRACE = "application/vnd.byoa.voice.trace+json";

// A scenario by name, or a recording the page shared, a WAV, to replay.
const name = process.argv[2] ?? "turns";
const scenario = name.endsWith(".wav")
	? null
	: scenarios.find((s) => s.name === name);
if (scenario === undefined) throw new Error(`no scenario ${name}`);
const key = (
	await readFile(join(homedir(), "secrets/elevenlabs-api-key.txt"), "utf8")
).trim();

const { wav, timeline, duration } = scenario
	? await speech(scenario, key)
	: await recording(name);

const server = await preview({ preview: { port: 0 }, logLevel: "silent" });
const page = server.resolvedUrls?.local[0];
if (!page) throw new Error("the page is not served");

// The agent answers each message at once, so the person's turns are measured
// on their own.
const agent = new Session(await create(RELAY), "agent");
await agent.join();
agent.subscribe({
	entry: (entry) => {
		if (entry.from === "person" && entry.type.startsWith("text/plain"))
			void agent.send("Okay.", { type: "text/plain" });
	},
});

const browser = await chromium.launch({
	executablePath: process.env.CHROMIUM ?? "",
	args: [
		"--use-fake-ui-for-media-stream",
		"--use-fake-device-for-media-stream",
		`--use-file-for-fake-audio-capture=${wav}%noloop`,
		"--autoplay-policy=no-user-gesture-required",
	],
});
try {
	const context = await browser.newContext();
	await context.addInitScript(
		([key]) => {
			localStorage.setItem("byoa-name", "person");
			localStorage.setItem("elevenlabs-key", key as string);
			localStorage.setItem("voice-sharing-trace", "true");
			// The fake microphone plays its file from when it is opened.
			const open = navigator.mediaDevices.getUserMedia.bind(
				navigator.mediaDevices,
			);
			navigator.mediaDevices.getUserMedia = async (constraints) => {
				const stream = await open(constraints);
				(window as { opened?: number }).opened ??= Date.now();
				return stream;
			};
		},
		[key],
	);
	const tab = await context.newPage();
	tab.on("pageerror", (error) => console.error("page:", error.message));
	await tab.goto(
		`${page}?relay=${encodeURIComponent(RELAY)}#session=${agent.link}`,
	);
	await tab.getByRole("button", { name: "Speak" }).click();
	await tab.getByRole("button", { name: "Listen" }).click();
	await tab.waitForTimeout((duration + 3) * 1000);
	const opened = await tab.evaluate(
		() => (window as { opened?: number }).opened,
	);
	if (opened === undefined) throw new Error("the microphone never opened");
	report(
		agent.log,
		opened,
		timeline,
		scenario?.turns.map((t) => t.parts.join(" ")) ?? [],
	);
} finally {
	await browser.close();
	await agent.leave().catch(() => {});
	await server.close();
}

type Event = { time: string; event: string } & Record<string, unknown>;

function report(
	log: Entry[],
	t0: number,
	timeline: Timeline,
	said: string[],
): void {
	const events: Event[] = log
		.filter((entry) => entry.from === "person" && entry.type === TRACE)
		.flatMap((entry) => JSON.parse(entry.text ?? "[]"));
	const kept = join(
		import.meta.dirname,
		".cache",
		`${basename(name)}.trace.json`,
	);
	void writeFile(kept, JSON.stringify(events, null, 1));
	console.log(`the page's trace: ${kept}`);
	// Why each send's turn ended, where the page's turn detection says.
	let reason: string | undefined;
	const sends: { at: number; text: string; reason?: string }[] = [];
	for (const e of events) {
		if (e.event === "turn.end") reason = String(e.reason);
		if (e.event !== "send") continue;
		sends.push({
			at: (Date.parse(e.time) - t0) / 1000,
			text: String(e.text),
			...(reason ? { reason } : {}),
		});
		reason = undefined;
	}
	const words = (s: string) =>
		s
			.toLowerCase()
			.replace(/[^a-z' ]/g, " ")
			.split(/\s+/)
			.filter(Boolean);
	/** How much of turn `t` the text `s` holds. */
	const share = (s: string, t: string) => {
		const heard = new Set(words(s));
		const all = words(t);
		return all.filter((w) => heard.has(w)).length / all.length;
	};
	// Each send belongs to the turn it holds most of, and holds two turns
	// when it holds most of a second one too.
	const turnOf = sends.map((s) => {
		const shares = said.map((t) => share(s.text, t));
		const best = shares.indexOf(Math.max(...shares));
		const merged = shares.some((x, i) => i !== best && x >= 0.6);
		return { best, merged };
	});
	// Silero's first speech, or else Scribe's first words, against when the
	// first turn starts in the audio: how far the clock is off.
	const onset =
		events.find((e) => e.event === "vad.speech") ??
		events.find((e) => e.event === "speaking");
	if (onset)
		console.log(
			`${onset.event} first at ${((Date.parse(onset.time) - t0) / 1000).toFixed(2)} s, said at ${timeline[0]?.start.toFixed(2)} s`,
		);
	const shared = log.filter(
		(entry) => entry.from === "person" && entry.type.startsWith("audio/wav"),
	);
	const seconds = shared.reduce((sum, e) => sum + (e.size - 44) / 32_000, 0);
	console.log(
		`audio shared: ${shared.length} stretch(es), ${seconds.toFixed(1)} s`,
	);
	console.log(`${name}: ${said.length} turns, ${sends.length} sends`);
	if (said.length === 0)
		for (const s of sends)
			console.log(
				`    at ${s.at.toFixed(2)} s${s.reason ? `, ended as ${s.reason}` : ""}: "${s.text}"`,
			);
	let cut = 0;
	for (const [i, text] of said.entries()) {
		const mine = sends.filter((_, j) => turnOf[j]?.best === i);
		const end = timeline[i]?.end ?? 0;
		const last = mine.at(-1);
		if (mine.length > 1) cut++;
		const latency = last ? (last.at - end).toFixed(2) : "never";
		console.log(
			`turn ${i + 1}: ${mine.length} send(s), ended ${latency} s after the speech: "${text}"`,
		);
		for (const s of mine)
			console.log(
				`    at ${s.at.toFixed(2)} s${s.reason ? `, ended as ${s.reason}` : ""}: "${s.text}"`,
			);
	}
	const merged = turnOf.filter((t) => t.merged).length;
	console.log(`cut off: ${cut}, merged: ${merged}`);
}

/** A recording to replay: its turns are unknown, so only its sends are told. */
async function recording(
	wav: string,
): Promise<{ wav: string; timeline: Timeline; duration: number }> {
	const header = new DataView((await readFile(wav)).buffer, 0, 44);
	const rate = header.getUint32(24, true);
	const bytes = header.getUint32(40, true);
	return { wav, timeline: [], duration: bytes / 2 / rate };
}
