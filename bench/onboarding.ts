// How a fresh agent takes the page's prompt: gives it, as the page does, to
// an agent without context in an empty directory, and records what it does
// and how long each step takes, until the page could start talking.
//
//   pnpm exec tsx bench/onboarding.ts [agent] [tier]
//
// `agent` is `claude` (Claude Code, `claude -p --safe-mode`) or `codex`
// (`codex exec`, on the OpenAI key in ~/secrets). Either runs in bubblewrap,
// with an empty home in place of the user's and the rest of the machine
// read-only, so that what it installs goes nowhere. `tier` is
// `local`, which ends at the engine's offer, or `elevenlabs`, which ends at
// the key's secret. A fake page takes the person's place, on the real relay:
// it sends the modes as the page does, and the public key on the ElevenLabs
// tier. The agent reads `public/agents.md` from this checkout, served on
// localhost, unless DOCS names another base, such as
// https://voice.agentics.lwirth.com. MODEL picks the model; the engine's
// models come from the user's cache, unless COLD=1, which has it fetch them;
// TIMEOUT is in seconds. Afterwards the agent is asked how the setup felt.
// Everything lands in bench/.cache/onboarding/<agent>-<tier>-<time>/.
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { create, type Entry, Secrets, Session } from "polylogue/participant";

const RELAY = "https://polylogue.agentics.lwirth.com";
const MODES = "application/vnd.polylogue.voice.modes+json";
const OFFER = "application/vnd.polylogue.engine.offer+json";
const SECRET = "application/vnd.polylogue.secret+json";
const PERSON = "luis";
const DEBRIEF =
	"That was a test of the voice page's setup, and the session is over: please don't run anything more. " +
	"In a few sentences: how did setting up feel to you? What made you hesitate, what was unclear, " +
	"what did you trust or not trust, and what would you have wanted to read instead?";

const agent = process.argv[2] ?? "claude";
const tier = process.argv[3] ?? "local";
if (!["claude", "codex"].includes(agent)) throw new Error(`no agent ${agent}`);
if (!["local", "elevenlabs"].includes(tier)) throw new Error(`no tier ${tier}`);
const timeout = Number(process.env.TIMEOUT ?? 600) * 1000;

const out = join(
	"bench/.cache/onboarding",
	`${agent}-${tier}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
await mkdir(out, { recursive: true });
const home = await mkdtemp(join(tmpdir(), "onboarding-"));
const cwd = join(home, "work");
await mkdir(cwd);

// The draft in this checkout, served as the page serves it. ENGINE, the path
// of an engine.py not yet published, serves it too, in place of its pinned
// link.
let docs = process.env.DOCS?.replace(/\/$/, "");
const PINNED =
	/https:\/\/raw\.githubusercontent\.com\/luiswirth\/polylogue-voice\/[^/]+\/engine\/engine\.py/g;
const server = createServer(async (request, response) => {
	try {
		const engine = process.env.ENGINE;
		let body: string;
		if (request.url === "/engine.py" && engine) {
			body = await readFile(engine, "utf8");
		} else {
			body = await readFile(join("public", request.url ?? "/"), "utf8");
			if (engine) body = body.replace(PINNED, `${docs}/engine.py`);
		}
		response.writeHead(200, { "Content-Type": "text/plain" }).end(body);
	} catch {
		response.writeHead(404).end();
	}
});
if (!docs) {
	await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
	const address = server.address();
	if (typeof address !== "object" || !address) throw new Error("no port");
	docs = `http://localhost:${address.port}`;
}

const start = Date.now();
const since = () => ((Date.now() - start) / 1000).toFixed(1);
const milestones: string[] = [];
const mark = (what: string) => {
	const line = `${since()}s ${what}`;
	milestones.push(line);
	console.log(line);
};

// The fake page: the person's side, as the page joins and waits.
const link = await create(RELAY);
const page = new Session(link, PERSON);
await page.join();
await page.send(JSON.stringify({ listener: true, speaker: true, tier }), {
	type: MODES,
});
const secrets = new Secrets(page);
if (tier === "elevenlabs") await secrets.publish();

let finish: (why: string) => void = () => {};
const finished = new Promise<string>((done) => {
	finish = done;
});
const entries: Entry[] = [];
page.subscribe({
	entry(entry) {
		entries.push(entry);
		if (entry.from === PERSON) return;
		const type = entry.type.split(";")[0];
		const what =
			type === "text/plain"
				? JSON.stringify(entry.text)
				: type === OFFER
					? `offer ${entry.text}`
					: type;
		mark(`${entry.from}: ${what}`);
		if (type === OFFER) finish("the engine's offer arrived");
		if (type === SECRET) finish("the key's secret arrived");
	},
});

// The page's prompt, or PROMPT's variant of it, with {docs}, {link} and
// {person}.
const prompt = (
	process.env.PROMPT ??
	"Read {docs}/agents.md and join the session {link} as {person}/<your name>"
)
	.replaceAll("{docs}", docs)
	.replaceAll("{link}", link)
	.replaceAll("{person}", PERSON);
await writeFile(join(out, "prompt.txt"), `${prompt}\n`);

// The agent, in an empty directory of an empty home, without the user's
// context, in a sandbox whose only writable places are that home and /tmp:
// Claude Code in safe mode, with its own directory for its login, and Codex
// on an API key.
const env: Record<string, string> = { ...process.env } as Record<
	string,
	string
>;
delete env.XDG_CACHE_HOME;
const engineCache = join(homedir(), ".cache/polylogue-voice-engine");
const sandbox = [
	"--ro-bind",
	"/",
	"/",
	"--dev",
	"/dev",
	"--proc",
	"/proc",
	"--bind",
	"/tmp",
	"/tmp",
	"--bind",
	home,
	homedir(),
	...(process.env.COLD ? [] : ["--bind", engineCache, engineCache]),
	"--chdir",
	join(homedir(), "work"),
];
if (agent === "claude") {
	const config = env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
	const installs = join(homedir(), ".local/share/claude");
	sandbox.push("--bind", config, config, "--ro-bind", installs, installs);
} else {
	env.CODEX_HOME = join(homedir(), ".codex");
	await mkdir(join(home, ".codex"));
	env.CODEX_API_KEY = readFileSync(
		join(homedir(), "secrets/openai-api-key.txt"),
		"utf8",
	).trim();
}
type Resume = { id: string; text: string } | null;
function command(resume: Resume): [string, string[]] {
	const model = process.env.MODEL;
	if (agent === "claude") {
		return [
			realpathSync(join(homedir(), ".local/bin/claude")),
			[
				"-p",
				"--safe-mode",
				"--output-format=stream-json",
				"--verbose",
				"--dangerously-skip-permissions",
				...(model ? ["--model", model] : ["--model", "sonnet"]),
				...(resume ? ["--resume", resume.id, resume.text] : [prompt]),
			],
		];
	}
	const flags = [
		"--json",
		"--skip-git-repo-check",
		"--dangerously-bypass-approvals-and-sandbox",
		"-m",
		model ?? "gpt-5.4",
	];
	return resume
		? ["codex", ["exec", "resume", ...flags, resume.id, resume.text]]
		: ["codex", ["exec", ...flags, prompt]];
}

/** Whether the agent's last words in its chat were a question. */
let asks = false;

/** Runs the agent, its output into `file`, until it ends its turn or `stop`
 * resolves; returns the id to resume it by. */
async function run(
	file: string,
	resume: Resume,
	stop: Promise<unknown>,
): Promise<string | null> {
	const [program, args] = command(resume);
	const child = spawn("bwrap", [...sandbox, "--", program, ...args], {
		env,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	let id: string | null = null;
	asks = false;
	child.stdout.on("data", (chunk: Buffer) => {
		output += chunk;
		for (const line of chunk.toString().split("\n")) {
			const event = parse(line);
			id ??= event?.session_id ?? event?.thread_id ?? null;
			const said = text(event);
			if (said) {
				mark(`${agent} in its chat: ${JSON.stringify(said)}`);
				asks = said.trim().endsWith("?");
			}
			const ran = shell(event);
			if (ran) mark(`${agent} runs: ${ran.slice(0, 160)}`);
		}
	});
	child.stderr.on("data", (chunk: Buffer) => {
		output += chunk;
	});
	const ended = new Promise<"ended">((done) =>
		child.on("close", () => done("ended")),
	);
	// Stopped from outside, the agent's whole group stops, the engine it
	// started in the background included, which leaves the session as it
	// stops; an agent that ended its turn keeps what it left running.
	if ((await Promise.race([ended, stop])) !== "ended") {
		try {
			process.kill(-(child.pid ?? 0), "SIGTERM");
		} catch {}
		await Promise.race([ended, new Promise((wake) => setTimeout(wake, 5000))]);
	}
	await writeFile(join(out, file), output);
	return id;
}

function parse(line: string): Record<string, any> | null {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

/** What the agent said in its chat, from either harness's JSON events. */
function text(event: Record<string, any> | null): string | null {
	if (event?.type === "assistant") {
		const parts = event.message?.content ?? [];
		const said = parts
			.filter((p: any) => p.type === "text")
			.map((p: any) => p.text)
			.join("");
		return said || null;
	}
	if (event?.type === "item.completed" && event.item?.type === "agent_message")
		return event.item.text;
	return null;
}

/** A command the agent ran, from either harness's JSON events. */
function shell(event: Record<string, any> | null): string | null {
	if (event?.type === "assistant") {
		const call = (event.message?.content ?? []).find(
			(p: any) => p.type === "tool_use",
		);
		if (!call) return null;
		return `${call.name} ${call.input?.command ?? call.input?.url ?? JSON.stringify(call.input)}`;
	}
	if (
		event?.type === "item.started" &&
		event.item?.type === "command_execution"
	)
		return event.item.command;
	return null;
}

mark(`prompt given: ${prompt}`);
const deadline = new Promise<string>((done) =>
	setTimeout(() => done(`no offer or key within ${timeout / 1000}s`), timeout),
);
let ended: string | null = null;
const why = Promise.race([finished, deadline]).then((reason) => {
	ended = reason;
	return reason;
});
// An agent that stops on a question gets the person's yes at once, up to
// twice.
let id = await run("agent.jsonl", null, why);
for (let asked = 1; asked <= 2 && id && asks && !ended; asked++) {
	mark("luis in the agent's chat: Yes, go ahead.");
	const text = "Yes, go ahead.";
	id = (await run(`agent-${asked}.jsonl`, { id, text }, why)) ?? id;
}
mark(`setup ended: ${ended ?? "the agent stopped first"}`);
await page.leave();
// An engine the agent started apart from its own group, found by the session's
// link on its command line.
spawn("pkill", ["-f", link.split("/").at(-1) ?? link]);

if (id) {
	mark("debrief");
	await run(
		"debrief.jsonl",
		{ id, text: DEBRIEF },
		new Promise((wake) => setTimeout(wake, 180_000)),
	);
}
server.close();

await writeFile(
	join(out, "session.jsonl"),
	entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
);
await writeFile(join(out, "milestones.txt"), milestones.join("\n") + "\n");
console.log(`recorded in ${out}`);
process.exit(0);
