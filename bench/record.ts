// Records a conversation of bench/conversation.ts as ground truth: it plays
// the agent in a real voice session, and serves a prompter, for a phone or a
// second screen, that tells the person what to say and when. Once they are
// through, it keeps what the page heard, its trace, the session's messages
// and the prompter's times, in `out`.
//
//   just record <out directory> [port]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import {
	create,
	type Entry,
	KEY,
	SECRET,
	Session,
} from "polylogue/participant";
import { conversation } from "./conversation.ts";
import { joined } from "./recording.ts";

const RELAY = "https://polylogue.agentics.lwirth.com";
const VOICE = "https://voice.agentics.lwirth.com";
const TRACE = "application/vnd.polylogue.voice.trace+json";
const NAMES = "application/vnd.polylogue.voice.names+json";

const [out, port = "8790"] = process.argv.slice(2);
if (!out) throw new Error("usage: record.ts <out directory> [port]");
await mkdir(out, { recursive: true });
const key = (
	await readFile(join(homedir(), "secrets/elevenlabs-api-key.txt"), "utf8")
).trim();

const agent = new Session(await create(RELAY), "agent");
await agent.join();
await agent.send("I'm here.", { type: "text/plain" });
const voice = `${VOICE}/#session=${agent.link}`;

/** What the prompter did, each at the time it reached the recorder. */
const prompter: ({ time: string; event: string } & Record<string, unknown>)[] =
	[];
const note = (event: string, data: Record<string, unknown> = {}) => {
	prompter.push({ time: new Date().toISOString(), event, ...data });
	console.log(event, JSON.stringify(data));
};

let named = false;
agent.subscribe({
	entry: (entry) => {
		if (entry.from === agent.name) return;
		if (entry.type.split(";")[0] === KEY)
			sendKey(entry).catch((e) => console.error("the key:", e));
		// The person's first voice is named, as an agent would, so that the
		// agent's own echo can't cut in.
		const voiceTag = entry.type.startsWith("text/plain")
			? /^\[voice (\d+)\]/.exec(entry.text ?? "")
			: null;
		if (voiceTag && !named) {
			named = true;
			void agent.send(JSON.stringify({ [voiceTag[1] ?? "1"]: "Luis" }), {
				type: NAMES,
			});
		}
		if (entry.type.startsWith("text/plain"))
			console.log(`${entry.from}: ${entry.text}`);
	},
});

/** Sends the ElevenLabs key to the page that asked for it, encrypted to its
 * key, as the transport's spec has secrets. */
async function sendKey(entry: Entry): Promise<void> {
	const pem = entry.text || (await (await agent.fetch(entry.n)).text());
	const der = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64");
	const publicKey = await crypto.subtle.importKey(
		"spki",
		der,
		{ name: "RSA-OAEP", hash: "SHA-256" },
		false,
		["encrypt"],
	);
	const data = await crypto.subtle.encrypt(
		{ name: "RSA-OAEP" },
		publicKey,
		new TextEncoder().encode(key),
	);
	await agent.send(
		JSON.stringify({
			key: entry.n,
			name: "elevenlabs",
			data: Buffer.from(data).toString("base64"),
		}),
		{ type: SECRET },
	);
	note("key.sent", { to: entry.from });
}

/** Keeps everything of the session, then leaves, which deletes it. */
async function keep(): Promise<void> {
	// The page shares its trace and audio after each message it sends.
	await new Promise((resolve) => setTimeout(resolve, 10_000));
	const traces = agent.log.filter((e) => e.type.startsWith(TRACE));
	const events = traces.flatMap((e) => JSON.parse(e.text ?? "[]"));
	const messages = agent.log.filter(
		(e) => !e.type.startsWith(TRACE) && !e.type.startsWith("audio/"),
	);
	// Without audio, the session stays, so that nothing is lost.
	const { wav, start } = await joined(agent).catch((e) => {
		console.error(e);
		return { wav: null, start: null };
	});
	if (wav) await writeFile(join(out ?? ".", "audio.wav"), wav);
	await writeFile(
		join(out ?? ".", "session.json"),
		JSON.stringify(
			{
				link: agent.link,
				audioStart: start && new Date(start).toISOString(),
				messages,
				trace: events,
				prompter,
			},
			null,
			1,
		),
	);
	console.log(`kept in ${out}`);
	if (wav) await agent.leave();
}

const page = await readFile(join(import.meta.dirname, "prompter.html"));
const server = createServer(async (request, response) => {
	const body = await new Promise<string>((resolve) => {
		let s = "";
		request.on("data", (c) => {
			s += c;
		});
		request.on("end", () => resolve(s));
	});
	const url = new URL(request.url ?? "/", "http://x");
	if (request.method === "GET" && url.pathname === "/") {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(page);
	} else if (url.pathname === "/conversation") {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ voice, conversation }));
	} else if (url.pathname === "/event") {
		const { event, ...data } = JSON.parse(body);
		note(event, data);
		if (event === "agent") await agent.send(data.text, { type: "text/plain" });
		response.end("ok");
		if (event === "done") {
			await keep().catch((e) => console.error(e));
			server.close();
		}
	} else {
		response.writeHead(404);
		response.end();
	}
});
server.listen(Number(port), "0.0.0.0");
console.log(`the voice page: ${voice}`);
console.log(`the prompter:   http://${hostname()}:${port}/`);
