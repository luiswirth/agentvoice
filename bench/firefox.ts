// Firefox playing the agent's messages on the local tier: a fake agent sends
// one every few seconds, or answers each message of a scenario's speech, and
// the page's trace tells whether each was heard to its end.
//
//   FIREFOX=<path> pnpm exec tsx bench/firefox.ts [messages] [every]
//
// FIREFOX is Playwright's build, as in nixpkgs#playwright-driver.browsers.
// Its audio needs a PulseAudio server, such as one with a null sink at
// PULSE_SERVER, and libpulse on LD_LIBRARY_PATH: without them the page's
// audio never runs.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { create, KEY, Session } from "agentwire/participant";
import { firefox } from "playwright-core";
import { preview } from "vite";
import { scenarios } from "./scenarios.ts";
import { sendSecret } from "./secret.ts";
import { speech } from "./speech.ts";

const RELAY = "https://agentwire.agentics.lwirth.com";
const count = Number(process.argv[2] ?? 8);
const every = Number(process.argv[3] ?? 12);
const texts = [
	"Sure.",
	"The relay passes text only. The audio goes straight to the engine, which runs on the machine I act on.",
	"Okay, I will look into it and come back to you in a minute.",
	"First we measure how long each turn takes to end. Then we look at the pauses that cut a turn in two, and at the ones that merge two turns into one.",
];

// SCENARIO: the person says a scenario of bench/scenarios.ts too, through a
// microphone made of its speech, and each of their messages is answered.
const scenario = scenarios.find((s) => s.name === process.env.SCENARIO);
const wav = scenario
	? await readFile(
			(
				await speech(
					scenario,
					(
						await readFile(
							join(homedir(), "secrets/elevenlabs-api-key.txt"),
							"utf8",
						)
					).trim(),
				)
			).wav,
		)
	: null;

const server = await preview({ preview: { port: 0 }, logLevel: "silent" });
const page = server.resolvedUrls?.local[0];
if (!page) throw new Error("the page is not served");
const agent = new Session(await create(RELAY), "person/agent");
await agent.join();
const pipe = await create(RELAY);
const engine = spawn(
	"uv",
	["run", join(import.meta.dirname, "../engine/engine.py"), pipe],
	{ stdio: ["ignore", "ignore", "inherit"] },
);
agent.subscribe({
	entry: (entry) => {
		if (entry.from === "person" && entry.type.startsWith(KEY))
			void sendSecret(agent, entry.n, "engine", pipe);
		if (entry.from === "person" && entry.type.startsWith("text/plain")) {
			console.log(`person: ${entry.text}`);
			void agent.send(scenario?.answer ?? (texts[1] as string), {
				type: "text/plain",
			});
		}
	},
});
const browser = await firefox.launch({
	executablePath: process.env.FIREFOX ?? "",
	firefoxUserPrefs: {
		"media.navigator.streams.fake": true,
		"media.navigator.permission.disabled": true,
		"media.autoplay.default": 0,
		"media.autoplay.block-webaudio": false,
	},
});
try {
	const context = await browser.newContext();
	await context.addInitScript((spoken) => {
		localStorage.setItem("agentvoice-name", "person");
		localStorage.setItem("voice-tier", "local");
		if (!spoken) return;
		// The microphone plays the scenario's speech, from when it opens.
		navigator.mediaDevices.getUserMedia = async () => {
			const audio = new AudioContext();
			const data = await (await fetch("/__scenario.wav")).arrayBuffer();
			const source = audio.createBufferSource();
			source.buffer = await audio.decodeAudioData(data);
			const out = audio.createMediaStreamDestination();
			source.connect(out);
			source.start();
			return out.stream;
		};
	}, wav !== null);
	if (wav)
		await context.route("**/__scenario.wav", (route) =>
			route.fulfill({ body: wav, contentType: "audio/wav" }),
		);
	const tab = await context.newPage();
	tab.on("pageerror", (error) => console.error("page:", error.message));
	tab.on("console", (m) => {
		if (m.type() === "error") console.error("console:", m.text());
	});
	await tab.goto(
		`${page}?relay=${encodeURIComponent(RELAY)}#session=${agent.link}`,
	);
	// Muted, so that the fake microphone's tone takes no floor.
	await tab.waitForFunction(() => document.body.innerText.length > 0, null, {
		timeout: 30_000,
	});
	// The engine offers once its models are loaded; a click starts the audio.
	await tab.waitForTimeout(40_000);
	const tap = tab.getByText("Tap to hear");
	if (await tap.isVisible()) await tap.click();
	await tab.waitForTimeout(1000);
	console.log(
		"audio:",
		await tab.evaluate(() => document.body.innerText.slice(0, 300)),
	);
	const mute = tab.getByRole("button", { name: /^Mute\b/ });
	if (!wav && (await mute.isVisible())) await mute.click();
	for (let i = 0; i < count; i++) {
		await agent.send(texts[i % texts.length] as string, {
			type: "text/plain",
		});
		console.log(`sent ${i + 1} at ${new Date().toISOString()}`);
		// HIDE: after the first, another tab comes to the front, so that the
		// page runs in the background, as next to a terminal.
		if (i === 0 && process.env.HIDE) {
			const other = await context.newPage();
			await other.goto("about:blank");
			await other.bringToFront();
			console.log(
				"hidden:",
				await tab.evaluate(() => document.visibilityState),
			);
		}
		// IDLE: seconds of silence before the next.
		if (i === 1 && process.env.IDLE)
			await tab.waitForTimeout(Number(process.env.IDLE) * 1000);
		// TOGGLE: the speaker off and on again after the third.
		if (i === 2 && process.env.TOGGLE) {
			const speaker = tab.getByRole("button", { name: /speaker/i }).first();
			await speaker.click();
			await tab.waitForTimeout(800);
			await speaker.click();
			console.log("toggled the speaker");
		}
		await tab.waitForTimeout(every * 1000);
	}
	await tab.waitForTimeout(Number(process.env.WAIT ?? 0) * 1000);
	const events = await tab.evaluate(() => {
		const all: { event: string }[] = [];
		for (let i = 0; i < sessionStorage.length; i++) {
			const k = sessionStorage.key(i) ?? "";
			if (k.startsWith("voice-trace "))
				all.push(...JSON.parse(sessionStorage.getItem(k) ?? "[]"));
		}
		return all;
	});
	for (const e of events)
		if (
			[
				"heard",
				"silent",
				"playback.failed",
				"audio",
				"short",
				"failed",
			].includes(e.event)
		)
			console.log(JSON.stringify(e));
} finally {
	await browser.close();
	engine.kill();
	await agent.leave().catch(() => {});
	await server.close();
}
