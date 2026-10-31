// Screenshots of what the person sees while setting up, step by step, on a
// Mac's window and an iPhone's, into bench/.cache/onboarding-pages/: the page
// built from here, on the real relay, with a scripted agent that joins and
// narrates as public/agents.md suggests.
//
//   just onboarding-pages
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { Session } from "polylogue/participant";
import { createServer } from "vite";

const RELAY = "https://polylogue.agentics.lwirth.com";
const out = join(import.meta.dirname, ".cache", "onboarding-pages");
await mkdir(out, { recursive: true });
const server = await createServer({ server: { port: 0 }, logLevel: "silent" });
await server.listen();
const url = `${server.resolvedUrls?.local[0]}?relay=${encodeURIComponent(RELAY)}`;
const browser = await chromium.launch({
	executablePath: process.env.CHROMIUM ?? "",
	args: [
		"--use-fake-ui-for-media-stream",
		"--use-fake-device-for-media-stream",
		"--autoplay-policy=no-user-gesture-required",
	],
});
const screens = {
	mac: { viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 },
	iphone: { viewport: { width: 390, height: 760 }, deviceScaleFactor: 3 },
};

const shot = async (tab: Page, screen: string, step: string) => {
	await tab.waitForTimeout(600);
	const file = join(out, `${screen}-${step}.png`);
	await tab.screenshot({ path: file });
	console.log(file);
};

/** Joins the session in `tab`'s address as an agent. */
const agent = async (tab: Page) => {
	await tab.waitForFunction(() => location.hash.includes("session="));
	const hash = await tab.evaluate(() => location.hash.slice(1));
	const link = new URLSearchParams(hash).get("session") ?? "";
	const session = new Session(link, "luis/claude");
	await session.join();
	return session;
};

try {
	for (const [screen, options] of Object.entries(screens)) {
		for (const tier of ["local", "elevenlabs"]) {
			const context = await browser.newContext({
				...options,
				permissions: ["microphone", "clipboard-write"],
			});
			const tab = await context.newPage();
			await tab.goto(url);
			if (tier === "local") await shot(tab, screen, "1-name");
			await tab.evaluate(() => localStorage.setItem("polylogue-name", "luis"));
			await tab.reload();
			await tab.waitForFunction(() => location.hash.includes("session="));
			await tab.waitForTimeout(1500);
			if (tier === "local") await shot(tab, screen, "2-start");
			const choice = tab.getByRole("radio", {
				name: tier === "local" ? /local/i : /elevenlabs/i,
			});
			if (await choice.count()) {
				await choice.first().check({ force: true });
				await shot(tab, screen, `3-${tier}-chosen`);
			} else if (tier === "local") {
				await tab.evaluate(() => localStorage.setItem("voice-tier", "local"));
			}
			// Copying the prompt only copies it: the page stays until the agent joins.
			await tab.getByRole("button", { name: /copy the prompt/i }).click();
			await shot(tab, screen, `3-${tier}-copied`);
			const session = await agent(tab);
			await session.send("I'm here.");
			await shot(tab, screen, `4-${tier}-joined`);
			if (tier === "local") {
				await session.send("Reading the engine.");
				await tab.waitForTimeout(300);
				await session.send("Starting it: the models are about 1 GB, once.");
			} else {
				await session.send("Sending your ElevenLabs key.");
			}
			await shot(tab, screen, `5-${tier}-narrating`);
			if (tier === "local") {
				// An engine's offer, as engine.md has it, which the page takes
				// as the voice being ready.
				const engine = new Session(session.link, "luis/engine");
				await engine.join();
				await engine.send(
					JSON.stringify({ transcription: "t", synthesis: "s" }),
					{
						type: "application/vnd.polylogue.engine.offer+json",
					},
				);
				await shot(tab, screen, "6-local-ready");
				// The agent leaving takes the page back to waiting, with the
				// engine still in the session, and its coming back to talking,
				// listening again if it was.
				// A tab starts listening once there is someone to talk with.
				const listen = tab.getByRole("button", { name: /^Listen \(/ });
				if (await listen.count()) await listen.click();
				await tab.waitForTimeout(500);
				await session.leave();
				await shot(tab, screen, "7-local-left");
				const back = new Session(session.link, "luis/claude-again");
				await back.join();
				await back.send("I'm back.");
				// Another person typing in the session: the page is its
				// person's ears toward the agents, so the stage leaves it out.
				const tristan = new Session(session.link, "tristan");
				await tristan.join();
				await tristan.send("Typed by tristan.");
				await shot(tab, screen, "8-local-back");
				console.log(
					"another person shown:",
					await tab.getByText("Typed by tristan.").count(),
				);
				await tristan.leave();
				const mic = tab.getByRole("button", { name: /listen/i });
				console.log("listening again:", await mic.getAttribute("aria-pressed"));
				await back.leave();
				await engine.leave();
				await context.close();
				continue;
			}
			await session.leave();
			await context.close();
		}
	}
} finally {
	await browser.close();
	await server.close();
}
