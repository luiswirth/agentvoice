// VoiceIO's server, on the agents' machine: serves the page, which is an
// agent's ear and mouth, and carries between it and the agent's IO, MindIO
// (~/dev/agentics/mindio). What the ear hears and what the mouth did reach
// the agent as events from `voice`, and what the agent writes for `voice`
// the mouth speaks, as it grows. An agent takes part while its IO holds the
// file `voice`, a JSON object with the name the person hears and sees,
// `name`, and who the voices are by their numbers, `voices`, such as
// `{"1": "Luis"}`, both optional: once any voice is named, only a named one
// cuts the mouth off. The log of a call is the items themselves, so the server
// keeps no state of its own beyond who has the page open.
//
// An agent without MindIO takes part over plain HTTP instead, as
// public/agents.md tells it: it joins with `PUT /api/agents/<id>`, hears with
// `GET .../hear`, which waits, and speaks with `POST .../say`. Its IO is then
// the server's own, a directory of the same shape in `--own`, the events
// there as JSON with their fields, since no MindIO keeps them.
//
//   node server/main.ts [--port 8790] [--page dist] [--agents <dir>]
//                       [--own <dir>] [--mindio <command>]
//                       [--allow-host <name>]...
//
// It listens on 127.0.0.1 alone, and answers only requests whose Host is
// localhost or a name given with --allow-host, such as the machine's on the
// tailnet, so that no other site's page reaches it, by rebinding a name of
// its own to this machine either.

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { homedir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { headers } from "./policy.ts";

const { values: args } = parseArgs({
	options: {
		port: { type: "string", default: "8790" },
		page: {
			type: "string",
			default: resolve(import.meta.dirname, "../dist"),
		},
		agents: {
			type: "string",
			default: join(homedir(), ".agents/mindio"),
		},
		own: {
			type: "string",
			default: join(homedir(), ".local/state/voiceio/agents"),
		},
		mindio: { type: "string", default: "mindio" },
		"allow-host": { type: "string", multiple: true, default: [] },
	},
});

const page = resolve(args.page);
/** The agents' IO, each `<dir>/<agent>`. */
const dir = resolve(args.agents);
/** The IO of the agents that take part over HTTP, each `<own>/<agent>`. */
const own = resolve(args.own);
const hosts = new Set([
	"localhost",
	"127.0.0.1",
	"[::1]",
	...args["allow-host"],
]);

/** The name the ear's events come from, and the mouth's items go to. */
const VOICE = "voice";

/** How long a read of the log waits for a change before it answers anyway. */
const WAIT = 25_000;
/** How long after its last look a page counts as gone, in milliseconds. */
const GONE = 15_000;

// The items' file names: `<time>.<name>.<ext>`, the name encoded one to one;
// `voice` is the same encoded.

const ITEM = /^(\d{8}T\d{6}\.\d{6}Z)\.([^.]+)\.(.+)$/;

/** An item's time, as an ISO 8601 date. */
function time(stamp: string): string {
	const [, y, mo, d, h, mi, s, f] =
		stamp.match(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)\.(\d{6})Z$/) ?? [];
	return `${y}-${mo}-${d}T${h}:${mi}:${s}.${f?.slice(0, 3)}Z`;
}

const TEXT: Record<string, string> = {
	txt: "text/plain",
	md: "text/markdown",
	markdown: "text/markdown",
};

// The agents.

type Agent = {
	id: string;
	name: string;
	io: string;
	/** Whether it takes part over HTTP, its IO the server's own. */
	own: boolean;
	/** Who the voices are, by their numbers. */
	voices: Record<string, string>;
};

/** An agent's id, its IO's directory name, as a path names it. */
const valid = (id: string) => /^[^/\\]+$/.test(id) && id !== "." && id !== "..";

const exists = (path: string) =>
	lstat(path).then(
		() => true,
		() => false,
	);

/** Where the agent `id`'s IO is: MindIO's, else the server's own. */
async function where(id: string): Promise<{ io: string; own: boolean }> {
	const mindio = join(dir, id);
	return (await exists(mindio)) || !(await exists(join(own, id)))
		? { io: mindio, own: false }
		: { io: join(own, id), own: true };
}

/** The agent `id`, while it takes part: while its IO holds `voice`. */
async function agent(id: string): Promise<Agent | null> {
	if (!valid(id)) return null;
	const { io, own } = await where(id);
	const file = await readFile(join(io, "voice"), "utf8").catch(() => null);
	if (file === null) return null;
	let voice: { name?: unknown; voices?: unknown } = {};
	try {
		voice = file.trim() ? JSON.parse(file) : {};
	} catch {}
	const named = typeof voice.name === "string" ? voice.name.trim() : "";
	// The agent's name is never the one what is heard comes from.
	const name = named && named !== VOICE ? named : id;
	const voices: Record<string, string> = {};
	if (typeof voice.voices === "object" && voice.voices !== null)
		for (const [n, who] of Object.entries(voice.voices))
			if (/^\d+$/.test(n) && typeof who === "string" && who.trim())
				voices[n] = who.trim();
	return { id, name, io, own, voices };
}

async function agents(): Promise<Agent[]> {
	const ids = [
		...new Set([
			...(await readdir(dir).catch(() => [])),
			...(await readdir(own).catch(() => [])),
		]),
	];
	const found = await Promise.all(ids.sort().map(agent));
	return found.filter((a) => a !== null);
}

// What changed beyond what a directory's watcher sees: an item that grew or
// became whole, and a page that came or went.

const changes = new EventTarget();
const changed = () => changes.dispatchEvent(new Event("change"));

// The items.

type Item = { path: string; file: string; stamp: string; ext: string };

async function items(dir: string, name: string): Promise<Item[]> {
	const files = await readdir(dir).catch(() => []);
	return files.flatMap((file) => {
		const [, stamp, who, ext] = file.match(ITEM) ?? [];
		return stamp && ext && who === name
			? [{ path: join(dir, file), file, stamp, ext }]
			: [];
	});
}

/** An item's text as far as it is written, and whether it is whole. */
type Text = { text: string; whole: boolean };

/** The text of each item read, by its file name, which moving it between
 * `new/` and `cur/` keeps: a whole one's never changes. */
const texts = new Map<string, Text>();

/** The text of an item the agent may still write, which `mindio follow`
 * gives as it grows, ending once the item is whole. */
function follow(item: Item): Text {
	const known = texts.get(item.file);
	if (known) return known;
	const text: Text = { text: "", whole: false };
	texts.set(item.file, text);
	const child = spawn(args.mindio, ["follow", item.path], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const decoder = new TextDecoder();
	child.stdout.on("data", (chunk: Buffer) => {
		text.text += decoder.decode(chunk, { stream: true });
		changed();
	});
	let error = "";
	child.stderr.on("data", (d: Buffer) => {
		error += d;
	});
	const end = async (code: number | null) => {
		if (code !== 0) {
			// A `mindio` that can't follow: the item is read as it is.
			console.error(`voiceio: can't follow ${item.file}: ${error.trim()}`);
			text.text = await readFile(item.path, "utf8").catch(() => text.text);
		} else text.text += decoder.decode();
		text.whole = true;
		changed();
	};
	child.on("error", () => void end(null));
	child.on("exit", (code) => void end(code));
	return text;
}

/** The text of an item the server wrote itself, whole at once, or as far
 * as it got where it wrote it as it came: an event, or what an agent over
 * HTTP said. An event in the server's own IO is JSON, with its text. */
async function written(item: Item): Promise<Text> {
	const known = texts.get(item.file);
	if (known) return known;
	const content = await readFile(item.path, "utf8").catch(() => "");
	const text = {
		text: item.ext === "json" ? stored(content).text : content,
		whole: true,
	};
	texts.set(item.file, text);
	return text;
}

// The server's own IO, for the agents over HTTP: the same shape as MindIO's,
// written by the server alone.

let last = 0;

/** A new item's time, as items name it, to the microsecond, and never the
 * same twice. */
function stamp(): string {
	const now = Math.max(Date.now() * 1000, last + 1);
	last = now;
	const date = new Date(Math.floor(now / 1000)).toISOString();
	const micro = String(now % 1_000_000).padStart(6, "0");
	return `${date.slice(0, 19).replace(/[-:]/g, "")}.${micro}Z`;
}

/** An event as the server's own IO keeps it. */
type Stored = { text: string; fields: Record<string, string | string[]> };

function stored(content: string): Stored {
	try {
		const { text, fields } = JSON.parse(content) as Partial<Stored>;
		return { text: text ?? "", fields: fields ?? {} };
	} catch {
		return { text: "", fields: {} };
	}
}

/** Fields as `name=value`, as an object, a value repeated as a list. */
function object(fields: string[]): Stored["fields"] {
	const all: Stored["fields"] = {};
	for (const field of fields) {
		const at = field.indexOf("=");
		const [key, value] = [field.slice(0, at), field.slice(at + 1)];
		const known = all[key];
		all[key] =
			known === undefined
				? value
				: [...(Array.isArray(known) ? known : [known]), value];
	}
	return all;
}

/** Writes an item into a box of the server's own IO, through `tmp/`. */
async function store(box: string, ext: string, content: string): Promise<void> {
	const file = `${stamp()}.${VOICE}.${ext}`;
	await mkdir(join(box, "tmp"), { recursive: true, mode: 0o700 });
	await mkdir(join(box, "new"), { recursive: true, mode: 0o700 });
	await writeFile(join(box, "tmp", file), content, { mode: 0o600 });
	await rename(join(box, "tmp", file), join(box, "new", file));
	changed();
}

/** Takes the events an agent over HTTP has not heard yet, into `cur/`. */
async function hear(a: Agent): Promise<object[]> {
	const inbox = join(a.io, "inbox");
	const fresh = (await items(join(inbox, "new"), VOICE)).sort((x, y) =>
		x.file < y.file ? -1 : 1,
	);
	await mkdir(join(inbox, "cur"), { recursive: true, mode: 0o700 });
	const heard = [];
	for (const item of fresh) {
		const path = join(inbox, "cur", item.file);
		if (
			!(await rename(item.path, path).then(
				() => true,
				() => false,
			))
		)
			continue;
		const { text, fields } = stored(await readFile(path, "utf8"));
		heard.push({ id: item.file, time: time(item.stamp), ...fields, text });
	}
	changed();
	return heard;
}

/** Writes what an agent over HTTP says into its outbox as it comes, so that
 * the mouth speaks it as it grows, as it does a streaming item of MindIO's. */
async function say(a: Agent, body: IncomingMessage): Promise<string> {
	const file = `${stamp()}.${VOICE}.txt`;
	const cur = join(a.io, "outbox", "cur");
	await mkdir(cur, { recursive: true, mode: 0o700 });
	const text: Text = { text: "", whole: false };
	texts.set(file, text);
	const handle = await open(join(cur, file), "wx", 0o600);
	const decoder = new TextDecoder();
	try {
		for await (const chunk of body) {
			const part = decoder.decode(chunk as Buffer, { stream: true });
			if (text.text.length + part.length > 64_000) break;
			text.text += part;
			await handle.write(part);
			changed();
		}
	} finally {
		text.text += decoder.decode();
		text.whole = true;
		await handle.close();
		changed();
	}
	return file;
}

/** Carries the agent's new items for the mouth: takes them into `cur/`,
 * which of several subscribers only one does for each, and follows each
 * there as it grows. */
async function carry(a: Agent): Promise<void> {
	const outbox = join(a.io, "outbox");
	const fresh = await items(join(outbox, "new"), VOICE);
	if (fresh.length === 0) return;
	await mkdir(join(outbox, "cur"), { recursive: true, mode: 0o700 });
	for (const item of fresh) {
		// Only a regular file is an item.
		if (!(await lstat(item.path).catch(() => null))?.isFile()) continue;
		const path = join(outbox, "cur", item.file);
		if (
			await rename(item.path, path).then(
				() => true,
				() => false,
			)
		)
			follow({ ...item, path });
	}
}

// The log of a call: the ear's and the mouth's events in the agent's inbox,
// and the agent's items for the mouth in its outbox, in the order of their
// times.

/** What an entry is: something heard, a note of the ear's or the mouth's,
 * or the agent's message to speak. */
type Kind = "heard" | "note" | "message";

type Entry = {
	n: number;
	/** The item's file name. */
	id: string;
	from: string;
	kind: Kind;
	type: string;
	time: string;
	text?: string;
	/** Whether the text is all there is: a message may still grow. */
	whole: boolean;
	filename?: string;
};

/** What the ear heard always starts with a voice's tag, which no note of
 * the server's does. */
const heard = (text: string) => text.startsWith("[voice ");

type Log = {
	revision: string;
	agent: { id: string; name: string; voices: Record<string, string> } | null;
	/** The name what is heard comes from. */
	person: string;
	entries: Entry[];
	/** The agent, while in voice mode, with the last entry heard it took in. */
	participants: Record<string, { read: number }>;
};

async function log(id: string): Promise<Log> {
	const a = await agent(id);
	const { io, own } = await where(id);
	const inbox = join(io, "inbox");
	const outbox = join(io, "outbox");
	if (a && !own) await carry(a);
	const [fresh, taken, said] = await Promise.all([
		items(join(inbox, "new"), VOICE),
		items(join(inbox, "cur"), VOICE),
		items(join(outbox, "cur"), VOICE),
	]);
	const name = a?.name ?? id;
	const all = [
		...fresh.map((item) => ({ item, out: false, taken: false })),
		...taken.map((item) => ({ item, out: false, taken: true })),
		...said.map((item) => ({ item, out: true, taken: false })),
	].sort((x, y) =>
		x.item.stamp < y.item.stamp ? -1 : x.item.stamp > y.item.stamp ? 1 : 0,
	);
	let read = 0;
	const entries = await Promise.all(
		all.map(async ({ item, out, taken }, i): Promise<Entry> => {
			const base = { n: i + 1, id: item.file, time: time(item.stamp) };
			const type = item.ext === "json" && !out ? TEXT.txt : TEXT[item.ext];
			if (type === undefined)
				return {
					...base,
					from: out ? name : VOICE,
					kind: out ? "message" : "note",
					type: "application/octet-stream",
					whole: true,
					filename: item.file,
				};
			const { text, whole } = out && !own ? follow(item) : await written(item);
			const kind: Kind = out ? "message" : heard(text) ? "heard" : "note";
			if (kind === "heard" && taken) read = i + 1;
			return { ...base, from: out ? name : VOICE, kind, type, text, whole };
		}),
	);
	const growth = entries.reduce(
		(sum, e) => sum + (e.whole ? 1 : 0) + (e.text?.length ?? 0),
		0,
	);
	return {
		revision: `${entries.length}.${read}.${growth}.${a ? JSON.stringify([a.name, a.voices]) : ""}`,
		agent: a && { id: a.id, name: a.name, voices: a.voices },
		person: VOICE,
		entries,
		participants: a ? { [a.name]: { read } } : {},
	};
}

/** Answers with what `look` sees once it differs from `revision`, as the
 * directories `dirs` change, or anything else does, or as it is after a
 * while. */
async function until<T extends { revision: string }>(
	dirs: string[],
	look: () => Promise<T>,
	revision: string | null,
	closed: AbortSignal,
): Promise<T> {
	let seen = await look();
	if (revision === null || seen.revision !== revision) return seen;
	return new Promise((done) => {
		const watchers = dirs.flatMap((dir) => {
			try {
				return [watch(dir, { recursive: true }, change)];
			} catch {
				return [];
			}
		});
		changes.addEventListener("change", change);
		let pending: ReturnType<typeof setTimeout> | undefined;
		const timer = setTimeout(end, WAIT);
		closed.addEventListener("abort", end);
		function change() {
			if (pending !== undefined) return;
			pending = setTimeout(async () => {
				pending = undefined;
				seen = await look();
				if (seen.revision !== revision) end();
			}, 30);
		}
		function end() {
			clearTimeout(timer);
			clearTimeout(pending);
			changes.removeEventListener("change", change);
			for (const w of watchers) w.close();
			done(seen);
		}
	});
}

// The events, into the agent's inbox through MindIO's own command line, so
// that the agent's waking rules decide whether each wakes it, by its fields.

function deliver(a: Agent, text: string, fields: string[]): Promise<void> {
	if (a.own)
		return store(
			join(a.io, "inbox"),
			"json",
			JSON.stringify({ text, fields: object(fields) }),
		);
	return new Promise((done, failed) => {
		const child = spawn(
			args.mindio,
			[
				"--mindio",
				a.io,
				"deliver",
				"--from",
				VOICE,
				"--type",
				"txt",
				...fields.flatMap((field) => ["--field", field]),
			],
			{ stdio: ["pipe", "ignore", "pipe"] },
		);
		let error = "";
		child.stderr.on("data", (d: Buffer) => {
			error += d;
		});
		child.on("error", failed);
		child.on("exit", (code) =>
			code === 0
				? done()
				: failed(new Error(error.trim() || `mindio exited ${code}`)),
		);
		child.stdin.end(text);
	});
}

/** How many words of a message a note quotes. */
const QUOTE = 12;

/** The first or last words of a text, marked where cut. */
function quote(text: string, end: "start" | "end"): string {
	const words = text.trim().split(/\s+/).filter(Boolean);
	if (words.length <= QUOTE) return `"${words.join(" ")}"`;
	return end === "start"
		? `"${words.slice(0, QUOTE).join(" ")}…"`
		: `"…${words.slice(-QUOTE).join(" ")}"`;
}

const on = (value: boolean) => (value ? "on" : "off");
const voiceField = (voice: unknown) =>
	`voice=${Number.isInteger(voice) ? voice : "unknown"}`;

/** An event of the page's as the item it delivers: its text and fields,
 * or null for one that isn't valid. */
function event(body: Record<string, unknown>): [string, string[]] | null {
	switch (body.event) {
		case "speech": {
			const { text, voices, backchannel } = body;
			if (typeof text !== "string" || !heard(text) || !Array.isArray(voices))
				return null;
			const each = voices.length > 0 ? voices : [null];
			return [
				text,
				[
					"event=speech",
					...[...new Set(each.map(voiceField))],
					`backchannel=${backchannel === true ? "yes" : "no"}`,
				],
			];
		}
		case "said": {
			const { message, whole, why, heard, unheard, by } = body;
			if (typeof message !== "string" || typeof heard !== "string") return null;
			const text = texts.get(message)?.text ?? "";
			if (whole === true)
				return [
					`Said to the end: ${quote(text, "start")}`,
					["event=said", "whole=yes"],
				];
			if (why !== "cut" && why !== "skipped") return null;
			const rest = typeof unheard === "string" ? unheard : "";
			const who =
				why === "cut"
					? `Cut off by ${voiceField(by).replace("=", " ")}`
					: "Skipped by the person";
			const where = heard
				? `after ${quote(heard, "end")}`
				: `before a word of ${quote(rest || text, "start")}`;
			return [
				`${who} ${where}.${heard && rest ? ` Not said: ${quote(rest, "start")}` : ""}`,
				[
					"event=said",
					"whole=no",
					`why=${why}`,
					...(why === "cut" ? [voiceField(by)] : []),
				],
			];
		}
		case "state": {
			const { ear, mouth } = body;
			if (typeof ear !== "boolean" || typeof mouth !== "boolean") return null;
			return [
				`Ear ${on(ear)}, mouth ${on(mouth)}.`,
				["event=state", `ear=${on(ear)}`, `mouth=${on(mouth)}`],
			];
		}
		case "problem": {
			const { text } = body;
			if (typeof text !== "string" || !text.trim()) return null;
			return [`Problem: ${text.trim()}`, ["event=problem"]];
		}
		default:
			return null;
	}
}

// Who has the page open, as an agent's ear and mouth: the state each page
// told, and what the agent was told last, so that a page that goes without
// saying so is told as both off.

type Senses = { ear: boolean; mouth: boolean };
type Presence = Senses & { told: Senses; looking: number; seen: number };
const pages = new Map<string, Presence>();

function presence(id: string): Presence {
	let p = pages.get(id);
	if (!p) {
		p = {
			ear: false,
			mouth: false,
			told: { ear: false, mouth: false },
			looking: 0,
			seen: Date.now(),
		};
		pages.set(id, p);
	}
	return p;
}

/** Tells the agent its ear and mouth as they are now, if that changed. */
async function tell(id: string): Promise<void> {
	const p = presence(id);
	const here = p.looking > 0 || Date.now() - p.seen < GONE;
	const now = { ear: here && p.ear, mouth: here && p.mouth };
	if (now.ear === p.told.ear && now.mouth === p.told.mouth) return;
	const a = await agent(id);
	if (a === null) return;
	p.told = now;
	const [text, fields] = event({ event: "state", ...now }) ?? ["", []];
	await deliver(a, text, fields).catch((error) => console.error(error));
}

setInterval(() => {
	for (const id of pages.keys()) void tell(id);
}, GONE / 3).unref();

// HTTP.

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".wasm": "application/wasm",
	".onnx": "application/octet-stream",
	".md": "text/markdown; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".webmanifest": "application/manifest+json",
};

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Cache-Control": "no-store",
	});
	res.end(JSON.stringify(body));
}

async function text(req: IncomingMessage): Promise<string> {
	let text = "";
	for await (const chunk of req) {
		text += chunk;
		if (text.length > 64_000) throw new Error("too long");
	}
	return text;
}

async function file(res: ServerResponse, pathname: string): Promise<void> {
	let path = resolve(page, `.${decodeURIComponent(pathname)}`);
	if (path !== page && !path.startsWith(page + sep)) return json(res, 404, {});
	if ((await lstat(path).catch(() => null))?.isDirectory())
		path = join(path, "index.html");
	const content = await readFile(path).catch(() => null);
	if (content === null) {
		console.error(`voiceio: no ${pathname}`);
		return json(res, 404, { error: "not found" });
	}
	res.writeHead(200, {
		...headers,
		"Content-Type": TYPES[extname(path)] ?? "application/octet-stream",
		"Cache-Control": "no-cache",
	});
	res.end(content);
}

async function api(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
): Promise<void> {
	const closed = new AbortController();
	res.on("close", () => closed.abort());
	const revision = url.searchParams.get("revision");
	if (url.pathname === "/api/agents" && req.method === "GET") {
		const seen = await until(
			[dir, own],
			async () => {
				const all = (await agents()).map(({ id, name }) => ({ id, name }));
				return { revision: JSON.stringify(all), agents: all };
			},
			revision,
			closed.signal,
		);
		return json(res, 200, seen);
	}
	const [, id, what] =
		url.pathname.match(
			/^\/api\/agents\/([^/]+)(?:\/(log|events|hear|say))?$/,
		) ?? [];
	if (!id || !valid(decodeURIComponent(id)))
		return json(res, 404, { error: "not found" });
	const name = decodeURIComponent(id);
	const { io } = await where(name);
	if (what === undefined) return await join_(req, res, name);
	if (what === "hear" || what === "say") {
		const a = await agent(name);
		if (a === null || !a.own)
			return json(res, 409, {
				error: `${name} has not joined over HTTP: PUT /api/agents/${id} first.`,
			});
		if (what === "say" && req.method === "POST") {
			const type = req.headers["content-type"] ?? "";
			if (!type.startsWith("text/plain"))
				return json(res, 415, { error: "send text/plain" });
			return json(res, 201, { id: await say(a, req) });
		}
		if (what === "hear" && req.method === "GET") {
			// It waits until there is something, unless `wait=0`.
			const wait = url.searchParams.get("wait") !== "0";
			while (!closed.signal.aborted) {
				const events = await hear(a);
				if (events.length > 0 || !wait) return json(res, 200, { events });
				await until(
					[join(io, "inbox")],
					async () => ({
						revision: String(
							(await items(join(io, "inbox", "new"), VOICE)).length,
						),
					}),
					"0",
					closed.signal,
				);
			}
			return;
		}
		return json(res, 405, { error: "not allowed" });
	}
	if (what === "log" && req.method === "GET") {
		const a = await agent(name);
		if (a === null && (await readdir(io).catch(() => null)) === null)
			return json(res, 404, { error: `There is no agent ${name}.` });
		// Entries after `after` are sent, and every one from the first that
		// may still grow.
		const after = Number(url.searchParams.get("after") ?? 0);
		const p = presence(name);
		p.looking += 1;
		void tell(name);
		try {
			const seen = await until([io], () => log(name), revision, closed.signal);
			return json(res, 200, {
				...seen,
				entries: seen.entries.filter((e) => e.n > after),
			});
		} finally {
			p.looking -= 1;
			p.seen = Date.now();
		}
	}
	if (what === "events" && req.method === "POST") {
		// A page of another origin sends no JSON without asking first, which
		// is never answered.
		if (!req.headers["content-type"]?.startsWith("application/json"))
			return json(res, 415, { error: "send JSON" });
		const a = await agent(name);
		if (a === null)
			return json(res, 409, { error: `${name} is not in voice mode.` });
		const body = JSON.parse(await text(req)) as Record<string, unknown>;
		if (body.event === "state") {
			const p = presence(name);
			p.ear = body.ear === true;
			p.mouth = body.mouth === true;
			p.seen = Date.now();
			await tell(name);
			return json(res, 201, {});
		}
		const item = event(body);
		if (item === null) return json(res, 400, { error: "not an event" });
		await deliver(a, ...item);
		return json(res, 201, {});
	}
	return json(res, 405, { error: "not allowed" });
}

/** An agent over HTTP joins with PUT, its name and voices as the file
 * `voice` has them, and leaves with DELETE. */
async function join_(
	req: IncomingMessage,
	res: ServerResponse,
	id: string,
): Promise<void> {
	const io = join(own, id);
	if (await exists(join(dir, id)))
		return json(res, 409, {
			error: `${id} is an agent of MindIO here: take part through its IO.`,
		});
	if (req.method === "PUT") {
		if (!req.headers["content-type"]?.startsWith("application/json"))
			return json(res, 415, { error: "send JSON" });
		const body = (await text(req)).trim() || "{}";
		if (typeof JSON.parse(body) !== "object")
			return json(res, 400, { error: "send a JSON object" });
		for (const box of ["inbox/new", "inbox/cur", "outbox/cur"])
			await mkdir(join(io, box), { recursive: true, mode: 0o700 });
		await writeFile(join(io, "voice"), body, { mode: 0o600 });
		changed();
		return json(res, 200, {
			page: `/#agent=${encodeURIComponent(id)}`,
		});
	}
	if (req.method === "DELETE") {
		await unlink(join(io, "voice")).catch(() => {});
		changed();
		return json(res, 200, {});
	}
	return json(res, 405, { error: "not allowed" });
}

const server = createServer(async (req, res) => {
	try {
		const host = req.headers.host ?? "";
		const hostname = host.replace(/:\d+$/, "");
		if (!hosts.has(hostname)) return json(res, 421, { error: "unknown host" });
		const origin = req.headers.origin;
		if (origin !== undefined && URL.parse(origin)?.host !== host)
			return json(res, 403, { error: "another origin" });
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname.startsWith("/api/")) return await api(req, res, url);
		if (req.method !== "GET" && req.method !== "HEAD")
			return json(res, 405, { error: "not allowed" });
		return await file(res, url.pathname);
	} catch (error) {
		console.error(error);
		if (!res.headersSent) json(res, 500, { error: (error as Error).message });
		else res.end();
	}
});

await mkdir(own, { recursive: true, mode: 0o700 });

server.listen(Number(args.port), "127.0.0.1", () => {
	const address = server.address();
	const port =
		typeof address === "object" && address ? address.port : args.port;
	console.log(`voiceio: http://localhost:${port}/`);
});
