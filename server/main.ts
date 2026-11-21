// agentvoice's server, on the agents' machine: serves the page, and carries
// the person's turns into an agent's inbox and the agent's outbox items for
// them back to the page, as ~/dev/agentics/inbox has the two. The person is
// `voice:<person>`: a turn is an inbox item from that name, which proposes to
// ring, and an outbox item for it is what the agent says, read aloud. An
// agent takes part while its inbox holds the file `voice`, a JSON object with
// the name the person hears and sees, `name`, and its outbox, `outbox`, both
// optional. The log of a call is the items themselves, so the server keeps no
// state of its own.
//
//   node server/main.ts [--port 8790] [--page dist] [--allow-host <name>]...
//
// It listens on 127.0.0.1 alone, and answers only requests whose Host is
// localhost or a name given with --allow-host, such as the machine's on the
// tailnet, so that no other site's page reaches it, by rebinding a name of
// its own to this machine either.

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { homedir, userInfo } from "node:os";
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
		inboxes: {
			type: "string",
			default: join(homedir(), ".agents/inbox"),
		},
		outboxes: {
			type: "string",
			default: join(homedir(), ".agents/outbox"),
		},
		person: { type: "string", default: userInfo().username },
		"allow-host": { type: "string", multiple: true, default: [] },
	},
});

const page = resolve(args.page);
const inboxes = resolve(args.inboxes);
const outboxes = resolve(args.outboxes);
/** The person's name, as the inbox has it. */
const person = `voice:${args.person}`;
const hosts = new Set([
	"localhost",
	"127.0.0.1",
	"[::1]",
	...args["allow-host"],
]);

/** How long a read of the log waits for a change before it answers anyway. */
const WAIT = 25_000;

// The inbox's file names: `<time>.<name>.<ext>`, the name encoded one to one.

const ITEM = /^(\d{8}T\d{6}\.\d{6}Z)\.([^.]+)\.(.+)$/;

function encode(name: string): string {
	let out = "";
	for (const b of new TextEncoder().encode(name)) {
		const c = String.fromCharCode(b);
		if (/[A-Za-z0-9-]/.test(c)) out += c;
		else if (c === "/") out += "_";
		else out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return out;
}

const PERSON = encode(person);

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

type Agent = { id: string; name: string; inbox: string; outbox: string };

/** An agent's id, its inbox's name, as a path names it. */
const valid = (id: string) => /^[^/\\]+$/.test(id) && id !== "." && id !== "..";

/** The agent `id`, while it takes part: while its inbox holds `voice`. */
async function agent(id: string): Promise<Agent | null> {
	if (!valid(id)) return null;
	const inbox = join(inboxes, id);
	const file = await readFile(join(inbox, "voice"), "utf8").catch(() => null);
	if (file === null) return null;
	let voice: { name?: unknown; outbox?: unknown } = {};
	try {
		voice = file.trim() ? JSON.parse(file) : {};
	} catch {}
	const name =
		typeof voice.name === "string" && voice.name.trim()
			? voice.name.trim()
			: id;
	return {
		id,
		// A name with a colon would pass for a person, as `voice:luis`.
		name: name.replaceAll(":", " "),
		inbox,
		outbox:
			typeof voice.outbox === "string" && voice.outbox.trim()
				? resolve(voice.outbox.trim())
				: join(outboxes, id),
	};
}

async function agents(): Promise<Agent[]> {
	const ids = await readdir(inboxes).catch(() => []);
	const found = await Promise.all(ids.sort().map(agent));
	return found.filter((a) => a !== null);
}

// The log of a call: the person's items in the agent's inbox, and the
// agent's for them in its outbox, in the order of their times.

type Entry = {
	n: number;
	from: string;
	type: string;
	time: string;
	text?: string;
	filename?: string;
};

/** Items are never changed once written, so their text is kept. */
const texts = new Map<string, string>();

async function items(
	dir: string,
	name: string,
): Promise<{ path: string; stamp: string; ext: string }[]> {
	const files = await readdir(dir).catch(() => []);
	return files.flatMap((file) => {
		const [, stamp, who, ext] = file.match(ITEM) ?? [];
		return stamp && ext && who === name
			? [{ path: join(dir, file), stamp, ext }]
			: [];
	});
}

/** Carries the agent's new items for the person: takes them into `cur/`,
 * which of several subscribers only one does for each. */
async function carry(a: Agent): Promise<void> {
	const fresh = await items(join(a.outbox, "new"), PERSON);
	if (fresh.length === 0) return;
	await mkdir(join(a.outbox, "cur"), { recursive: true, mode: 0o700 });
	for (const item of fresh) {
		// Only a regular file is an item.
		if (!(await lstat(item.path).catch(() => null))?.isFile()) continue;
		await rename(
			item.path,
			join(a.outbox, "cur", item.path.slice(item.path.lastIndexOf(sep) + 1)),
		).catch(() => {});
	}
}

async function entry(
	item: { path: string; stamp: string; ext: string },
	from: string,
): Promise<Omit<Entry, "n">> {
	const type = TEXT[item.ext];
	const at = time(item.stamp);
	if (type === undefined)
		return {
			from,
			type: "application/octet-stream",
			time: at,
			filename: item.path.slice(item.path.lastIndexOf(sep) + 1),
		};
	let text = texts.get(item.path);
	if (text === undefined) {
		text = await readFile(item.path, "utf8").catch(() => "");
		texts.set(item.path, text);
	}
	return { from, type, time: at, text };
}

type Log = {
	revision: string;
	agent: { id: string; name: string } | null;
	person: string;
	entries: Entry[];
	/** Who else is in the call, with the person's last entry they took in. */
	participants: Record<string, { read: number }>;
};

async function log(id: string): Promise<Log> {
	const a = await agent(id);
	const inbox = join(inboxes, id);
	const outbox = a?.outbox ?? join(outboxes, id);
	if (a) await carry(a);
	const [fresh, taken, said] = await Promise.all([
		items(join(inbox, "new"), PERSON),
		items(join(inbox, "cur"), PERSON),
		items(join(outbox, "cur"), PERSON),
	]);
	const name = a?.name ?? id;
	const all = [
		...fresh.map((item) => ({ item, from: person, taken: false })),
		...taken.map((item) => ({ item, from: person, taken: true })),
		...said.map((item) => ({ item, from: name, taken: false })),
	].sort((x, y) =>
		x.item.stamp < y.item.stamp ? -1 : x.item.stamp > y.item.stamp ? 1 : 0,
	);
	const entries = await Promise.all(
		all.map(async ({ item, from }, i) => ({
			n: i + 1,
			...(await entry(item, from)),
		})),
	);
	const read = all.reduce((last, x, i) => (x.taken ? i + 1 : last), 0);
	return {
		revision: `${entries.length}.${read}.${a ? encode(a.name) : ""}`,
		agent: a && { id: a.id, name: a.name },
		person,
		entries,
		participants: a ? { [a.name]: { read } } : {},
	};
}

/** Answers with what `look` sees once it differs from `revision`, as the
 * directories `dirs` change, or as it is after a while. */
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
				return [watch(dir, { recursive: true }, changed)];
			} catch {
				return [];
			}
		});
		let pending: ReturnType<typeof setTimeout> | undefined;
		const timer = setTimeout(end, WAIT);
		closed.addEventListener("abort", end);
		function changed() {
			clearTimeout(pending);
			pending = setTimeout(async () => {
				seen = await look();
				if (seen.revision !== revision) end();
			}, 30);
		}
		function end() {
			clearTimeout(timer);
			clearTimeout(pending);
			for (const w of watchers) w.close();
			done(seen);
		}
	});
}

/** Delivers a turn of the person's into the agent's inbox, proposing to
 * ring, through the inbox's own command line, so that the agent's
 * do-not-disturb settings dispose. */
function deliver(a: Agent, text: string): Promise<void> {
	return new Promise((done, failed) => {
		const child = spawn(
			"agentinbox",
			[
				"deliver",
				"--inbox",
				a.inbox,
				"--from",
				person,
				"--type",
				"txt",
				"--wake",
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
				: failed(new Error(error.trim() || `agentinbox exited ${code}`)),
		);
		child.stdin.end(text);
	});
}

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

async function body(req: IncomingMessage): Promise<string> {
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
		console.error(`agentvoice: no ${pathname}`);
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
			[inboxes],
			async () => {
				const all = (await agents()).map(({ id, name }) => ({ id, name }));
				return { revision: encode(JSON.stringify(all)), person, agents: all };
			},
			revision,
			closed.signal,
		);
		return json(res, 200, seen);
	}
	const [, id, what] =
		url.pathname.match(/^\/api\/agents\/([^/]+)\/(log|turns)$/) ?? [];
	if (!id || !valid(decodeURIComponent(id)))
		return json(res, 404, { error: "not found" });
	const name = decodeURIComponent(id);
	if (what === "log" && req.method === "GET") {
		const a = await agent(name);
		if (
			a === null &&
			(await readdir(join(inboxes, name)).catch(() => null)) === null
		)
			return json(res, 404, { error: `There is no agent ${name}.` });
		const after = Number(url.searchParams.get("after") ?? 0);
		const seen = await until(
			[join(inboxes, name), a?.outbox ?? join(outboxes, name)],
			() => log(name),
			revision,
			closed.signal,
		);
		return json(res, 200, {
			...seen,
			entries: seen.entries.filter((e) => e.n > after),
		});
	}
	if (what === "turns" && req.method === "POST") {
		// A page of another origin sends no JSON without asking first, which
		// is never answered.
		if (!req.headers["content-type"]?.startsWith("application/json"))
			return json(res, 415, { error: "send JSON" });
		const a = await agent(name);
		if (a === null)
			return json(res, 409, { error: `${name} is not in voice mode.` });
		const { text } = JSON.parse(await body(req)) as { text?: unknown };
		if (typeof text !== "string" || !text.trim())
			return json(res, 400, { error: "say something" });
		await deliver(a, text);
		return json(res, 201, {});
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

server.listen(Number(args.port), "127.0.0.1", () => {
	const address = server.address();
	const port =
		typeof address === "object" && address ? address.port : args.port;
	console.log(`agentvoice: http://localhost:${port}/, for ${person}`);
});
