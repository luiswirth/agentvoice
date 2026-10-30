// What the page tells of the others, against the real relay: an agent as
// agents.md has it, with plain requests and a receive from its read position,
// joins, reads the person's message, works, sends a file, answers, and leaves.
import { create, Session } from "polylogue/participant";
import { Activity } from "../src/voice/activity.ts";

const RELAY = "https://polylogue.agentics.lwirth.com";
const start = Date.now();
const log = (what: string) =>
	console.log(`${((Date.now() - start) / 1000).toFixed(2)}s ${what}`);
const sleep = (s: number) => new Promise((wake) => setTimeout(wake, s * 1000));

const link = await create(RELAY);
const page = new Session(link, "person");
await page.join();
const activity = new Activity(page, "person", {
	read: () => log("read"),
	message: () => log("message"),
	other: () => log("other"),
	joined: (name) => log(`joined ${name}`),
	left: (name) => log(`left ${name}`),
	progress: (progress) => log(`progress ${progress}`),
});

await sleep(1);
const joined = (await (
	await fetch(`${link}/join?as=agent`, { method: "POST" })
).json()) as { link: string };
const me = joined.link;
await fetch(me, { method: "POST", body: "I'm here." });
await fetch(`${me}?wait=0`);
await sleep(1);

// The agent's receive waits in the background, as agents.md has it.
const received = fetch(`${me}?wait=30`).then((r) => r.text());
await sleep(1);
log("person sends");
await page.send("Look at the tests.", { type: "text/plain" });
await received;
log("agent received");
await sleep(4);
await fetch(`${me}?filename=plot.png`, {
	method: "POST",
	headers: { "Content-Type": "image/png" },
	body: "png",
});
await sleep(2);
await fetch(me, { method: "POST", body: "They pass." });
await sleep(1);
await fetch(`${me}/leave`, { method: "POST" });
await sleep(1);
activity.close();
await page.leave();
