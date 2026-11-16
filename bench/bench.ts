// The test bench: plays a scenario's speech into the real page, built from
// this checkout, through Chromium's fake microphone, in a session of Vibe
// Together with a scripted agent, and measures from the page's trace how the
// turns reached the agent.
//
//   just bench [scenario]
//
// It signs in with the person token `just token` keeps, and uses the
// ElevenLabs key in ~/secrets/elevenlabs-api-key.txt. The session is the
// person's own group's `agentvoice bench`, which the agent creates once, or
// `SESSION=<id>`. The agent is `agentvoice-bench`, of the machine's agent
// token.
// `SHOTS=<seconds>` takes a screenshot of the page that often, into
// bench/.cache/shots, at `VIEWPORT=<width>x<height>`. `THROTTLE=<rate>` slows
// the page's CPU down that many times, as a phone's. `PAGE=<url>` plays into
// the page served there instead, such as the deployed one. `ANSWER=<text>` has
// the agent answer with it rather than "Okay." or the scenario's answer, so
// that a long one is read while the person speaks on; `ANSWER=` leaves
// answering to another agent in the session, such as a real one, and
// `HOLD=<seconds>` keeps the page open that long after the speech, for it.
// A run fails where nothing reached the agent, or none of its answers was read,
// or a turn said over an answer doesn't start with what of it was heard.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { chromium } from "playwright-core";
import { preview } from "vite";
import type { Entry } from "../src/vt/vibetogether_client.js";
import { scenarios } from "./scenarios.ts";
import { speech, type Timeline } from "./speech.ts";
import { BENCH, agent as bench, person } from "./vt.ts";

// A scenario by name, or a recording the page shared, a WAV, to replay.
const name = process.argv[2] ?? "turns";
const scenario = name.endsWith(".wav")
	? null
	: scenarios.find((s) => s.name === name);
if (scenario === undefined) throw new Error(`no scenario ${name}`);
const key = (
	await readFile(join(homedir(), "secrets/elevenlabs-api-key.txt"), "utf8")
).trim();

const { wav, timeline, duration, said } = scenario
	? {
			...(await speech(scenario, key)),
			said: scenario.turns.map((t) => t.parts.join(" ")),
		}
	: await recording(name);

const server = process.env.PAGE
	? null
	: await preview({ preview: { port: 0 }, logLevel: "silent" });
const page = process.env.PAGE ?? server?.resolvedUrls?.local[0];
if (!page) throw new Error("the page is not served");

// The session, and the agent in it, which answers each message of the
// person's at once, so that the person's turns are measured on their own.
const answer = process.env.ANSWER ?? scenario?.answer ?? "Okay.";
const { client, token } = await person();
const me = (await client.me()).name;
const agent = await bench();
const session = process.env.SESSION ?? (await agent.session(BENCH));
await Promise.all([client.join(session), agent.join(session)]);
const log: Entry[] = [];
const watching = new AbortController();
const watch = (async () => {
	let revision: string | undefined;
	while (!watching.signal.aborted) {
		const after = log.at(-1)?.n ?? 0;
		const answered = await client
			.log(session, revision ? { after, revision } : { after }, watching.signal)
			.catch(() => null);
		if (!answered) continue;
		revision = answered.revision;
		for (const entry of answered.entries.filter((e) => e.n > after)) {
			log.push(entry);
			if (answer && entry.from === me && entry.type.startsWith("text/plain"))
				void agent.send(session, answer);
		}
	}
})();

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
	const [width, height] = (process.env.VIEWPORT ?? "1280x800")
		.split("x")
		.map(Number);
	const context = await browser.newContext({
		viewport: { width: width ?? 1280, height: height ?? 800 },
	});
	await context.addInitScript(
		([key, token, recorded]) => {
			localStorage.setItem("vibetogether-token", token as string);
			localStorage.setItem("elevenlabs-key", key as string);
			// The fake microphone plays its file from when it is opened.
			const open = navigator.mediaDevices.getUserMedia.bind(
				navigator.mediaDevices,
			);
			// A recording already passed through the processing of the
			// microphone it was made on, so it is heard without it again: else
			// gain control makes it louder than the trace has it.
			navigator.mediaDevices.getUserMedia = async (constraints) => {
				const audio = constraints?.audio;
				const stream = await open(
					recorded && typeof audio === "object"
						? {
								...constraints,
								audio: {
									...audio,
									echoCancellation: false,
									noiseSuppression: false,
									autoGainControl: false,
								},
							}
						: constraints,
				);
				(window as { processing?: unknown }).processing ??= stream
					.getAudioTracks()[0]
					?.getSettings();
				(window as { opened?: number }).opened ??= Date.now();
				return stream;
			};
		},
		[key, token, scenario === null] as const,
	);
	const tab = await context.newPage();
	const throttle = Number(process.env.THROTTLE ?? 1);
	if (throttle > 1)
		await (await context.newCDPSession(tab)).send(
			"Emulation.setCPUThrottlingRate",
			{ rate: throttle },
		);
	tab.on("pageerror", (error) =>
		console.error("page:", error.stack ?? error.message),
	);
	await tab.goto(`${page}#session=${session}`);
	// The speaker is on from the start, and reads the agent's answers.
	const speak = tab.getByRole("button", { name: "Speak", exact: true });
	if (await speak.isVisible()) await speak.click();
	// The listener starts on by itself; muted, it is unmuted.
	const listen = tab.getByRole("button", { name: /^Unmute\b/ });
	if (await listen.isVisible()) await listen.click();
	// The microphone opens once the models are loaded, local ones taking a while.
	await tab
		.waitForFunction(() => (window as { opened?: number }).opened, null, {
			timeout: 120_000,
		})
		.catch(() => {});
	const every = Number(process.env.SHOTS ?? 0);
	if (every > 0) {
		const shots = join(import.meta.dirname, ".cache", "shots");
		await mkdir(shots, { recursive: true });
		const until = Date.now() + (duration + 3) * 1000;
		for (let i = 0; Date.now() < until; i++) {
			const next = Date.now() + every * 1000;
			await tab.screenshot({
				path: join(
					shots,
					`${basename(name)}-${String(i).padStart(4, "0")}.png`,
				),
			});
			await tab.waitForTimeout(Math.max(0, next - Date.now()));
		}
		console.log(`shots: ${shots}`);
	} else
		await tab.waitForTimeout(
			(duration + 3 + Number(process.env.HOLD ?? 0)) * 1000,
		);
	const opened = await tab.evaluate(
		() => (window as { opened?: number }).opened,
	);
	if (opened === undefined) throw new Error("the microphone never opened");
	const { echoCancellation, noiseSuppression, autoGainControl } =
		(await tab.evaluate(
			() => (window as { processing?: MediaTrackSettings }).processing,
		)) ?? {};
	console.log(
		`the microphone's processing: echo cancellation ${echoCancellation}, noise suppression ${noiseSuppression}, gain control ${autoGainControl}`,
	);
	// The page keeps its trace for the tab, as it offers it for download.
	const events: Event[] = await tab.evaluate(() =>
		JSON.parse(sessionStorage.getItem(`voice-trace ${location.href}`) ?? "[]"),
	);
	const reached = log.filter(
		(entry) => entry.from === me && entry.type.startsWith("text/plain"),
	).length;
	console.log(`messages that reached the session: ${reached}`);
	const { sends, read } = report(events, opened, timeline, said);
	if (sends === 0 || reached === 0)
		throw new Error("nothing the person said reached the agent");
	if (read === 0) throw new Error("none of the agent's answers was read");
	cutIns(events, log);
} finally {
	await browser.close();
	watching.abort();
	await watch;
	await agent.leave(session).catch(() => {});
	await server?.close();
}

type Event = { time: string; event: string } & Record<string, unknown>;

/** Checks that the message of each turn said over an answer starts with what
 * of the answer was heard: a start of it, cut before its end, and no more than
 * could be read from when its reading began to when the person took the
 * floor. */
function cutIns(events: Event[], log: Entry[]): void {
	/** A fast speaker's rate, in characters a second: more of an answer
	 * can't have been heard in the time it was read. */
	const FAST = 20;
	const at = (event: string, id: string) =>
		Date.parse(
			events.find((e) => e.event === event && String(e.id ?? e.reading) === id)
				?.time ?? "",
		) / 1000;
	const answers = new Set(
		log.filter((e) => e.from.includes("/")).map((e) => e.n),
	);
	const letters = (s: string) =>
		s
			.toLowerCase()
			.replace(/[^a-z ]/g, "")
			.replace(/\s+/g, " ")
			.trim();
	const flat = (s: string) => s.replace(/\s+/g, " ").trim();
	const messages = log
		.filter((e) => e.from === me && e.type.startsWith("text/plain"))
		.map((e) => e.text ?? "");
	for (const [i, turn] of (scenario?.turns ?? []).entries()) {
		if (!turn.cutIn) continue;
		// Its message is the one with the turn's last words.
		const tail = letters(turn.parts.join(" ")).split(" ").slice(-2).join(" ");
		const message = messages.find((m) => letters(m).includes(tail));
		console.log(
			`turn ${i + 1}, said over an answer: "${message ?? "never sent"}"`,
		);
		const mark = message?.match(/^\[cut in on (\d+) after "([^"]*)"\]/);
		const heard = flat(mark?.[2] ?? "");
		if (
			!mark ||
			!answers.has(Number(mark[1])) ||
			heard === "" ||
			!flat(answer).startsWith(heard) ||
			heard.length >= flat(answer).length
		)
			throw new Error(
				`turn ${i + 1} doesn't start with what of an answer was heard`,
			);
		const read = at("floor", mark[1] ?? "") - at("reading", mark[1] ?? "");
		console.log(
			`    heard ${heard.split(" ").length} of ${flat(answer).split(" ").length} words, ${heard.length} characters in ${read.toFixed(2)} s read`,
		);
		if (!(heard.length <= FAST * read))
			throw new Error(`turn ${i + 1} heard more of the answer than was read`);
	}
}

function report(
	events: Event[],
	t0: number,
	timeline: Timeline,
	said: string[],
): { sends: number; read: number } {
	const kept = join(
		import.meta.dirname,
		".cache",
		`${basename(name)}.trace.json`,
	);
	void mkdir(dirname(kept), { recursive: true }).then(() =>
		writeFile(kept, JSON.stringify(events, null, 1)),
	);
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
	// Each send belongs to the turn said last before it, where it comes at
	// most `LATE` seconds after that turn's end, and else to none: words
	// nobody said as a turn, such as echo or noise. It holds two turns when
	// it holds most of the turn before too.
	const LATE = 3;
	const turnOf = sends.map((s) => {
		const best = timeline.findLastIndex((t) => t.start <= s.at);
		if (best < 0 || s.at > (timeline[best]?.end ?? 0) + LATE)
			return { best: -1, merged: false };
		const before = said[best - 1];
		const merged = before !== undefined && share(s.text, before) >= 0.6;
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
	const stray = sends.filter((_, j) => turnOf[j]?.best === -1);
	if (stray.length > 0) console.log(`${stray.length} send(s) of no turn:`);
	for (const s of stray)
		console.log(
			`    at ${s.at.toFixed(2)} s${s.reason ? `, ended as ${s.reason}` : ""}: "${s.text}"`,
		);
	const merged = turnOf.filter((t) => t.merged).length;
	console.log(
		`cut off: ${cut}, merged: ${merged}, of no turn: ${stray.length}`,
	);
	const read = events.filter(
		(e) => e.event === "reading" && typeof e.id === "string",
	).length;
	console.log(`answers read: ${read}`);
	const short = events.findLast((e) => e.event === "short")?.samples ?? 0;
	console.log(`playback short of samples: ${short}`);
	return { sends: sends.length, read };
}

/** A recording to replay, such as the audio of a trace the page let the
 * person download, with its turns where a labels.json beside it has them,
 * else with its sends told only. */
async function recording(wav: string): Promise<{
	wav: string;
	timeline: Timeline;
	duration: number;
	said: string[];
}> {
	const header = new DataView((await readFile(wav)).buffer, 0, 44);
	const rate = header.getUint32(24, true);
	const bytes = header.getUint32(40, true);
	const labels = await readFile(join(dirname(wav), "labels.json"), "utf8")
		.then(
			(text) =>
				JSON.parse(text).turns as {
					text: string;
					start: number | null;
					end: number | null;
				}[],
		)
		.catch(() => []);
	const turns = labels.filter((t) => t.start !== null && t.end !== null);
	return {
		wav,
		timeline: turns.map((t) => ({ start: t.start ?? 0, end: t.end ?? 0 })),
		duration: bytes / 2 / rate,
		said: turns.map((t) => t.text),
	};
}
