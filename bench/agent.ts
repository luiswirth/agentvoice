// The bench's side of a call: agentvoice's server from this checkout, over a
// scratch folder of inboxes and outboxes, or one already running over this
// machine's, and a scripted agent in voice mode there, as an agent's inbox and
// outbox have it.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { watch } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Entry } from "../src/voice/protocol.ts";

export type Server = {
	/** Where the page is served. */
	url: string;
	inboxes: string;
	outboxes: string;
	close(): Promise<void>;
};

/** The server from this checkout over a scratch folder, serving dist/, or
 * the one at `url`, over this machine's inboxes and outboxes. */
export async function server(url?: string): Promise<Server> {
	if (url)
		return {
			url,
			inboxes: join(homedir(), ".agents/inbox"),
			outboxes: join(homedir(), ".agents/outbox"),
			close: async () => {},
		};
	const root = await mkdtemp(join(tmpdir(), "agentvoice-bench-"));
	const inboxes = join(root, "inbox");
	const outboxes = join(root, "outbox");
	const child: ChildProcess = spawn(
		process.execPath,
		[
			join(import.meta.dirname, "../server/main.ts"),
			"--port",
			"0",
			"--inboxes",
			inboxes,
			"--outboxes",
			outboxes,
		],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
	const served = await new Promise<string>((done, failed) => {
		child.stdout?.on("data", (d: Buffer) => {
			const found = String(d).match(/http:\/\/localhost:\d+\//)?.[0];
			if (found) done(found);
		});
		child.on("exit", (code) => failed(new Error(`the server exited ${code}`)));
	});
	return {
		url: served,
		inboxes,
		outboxes,
		close: async () => {
			child.kill();
			await rm(root, { recursive: true, force: true });
		},
	};
}

/** The scripted agent, `agentvoice-bench`, in voice mode while it lives:
 * it takes in each of the person's turns at once, and answers each with
 * `answer`, where there is one. */
export async function agent(
	at: Server,
	answer: string,
): Promise<{ id: string; close(): Promise<void> }> {
	const id = "agentvoice-bench";
	const inbox = join(at.inboxes, id);
	const outbox = join(at.outboxes, id);
	for (const dir of ["new", "cur", "tmp"])
		await mkdir(join(inbox, dir), { recursive: true, mode: 0o700 });
	await writeFile(join(inbox, "voice"), JSON.stringify({ name: "bench" }));
	const fresh = join(inbox, "new");
	let busy = Promise.resolve();
	const take = () => {
		busy = busy.then(async () => {
			for (const file of (await readdir(fresh)).sort()) {
				if (!file.includes(".voice%3A")) continue;
				await rename(join(fresh, file), join(inbox, "cur", file));
				if (answer) await send(outbox, file, answer);
			}
		});
	};
	const watcher = watch(fresh, take);
	take();
	return {
		id,
		close: async () => {
			watcher.close();
			await busy;
			await rm(inbox, { recursive: true, force: true });
			await rm(outbox, { recursive: true, force: true });
		},
	};
}

/** Answers the item `file` with `text`, for whoever it came from. */
function send(outbox: string, file: string, text: string): Promise<void> {
	const sender = decodeURIComponent(file.split(".")[2] ?? "");
	return new Promise((done, failed) => {
		const child = execFile(
			"agentinbox",
			["send", "--outbox", outbox, "--type", "txt", sender],
			(error) => (error ? failed(error) : done()),
		);
		child.stdin?.end(text);
	});
}

/** The call's log, as the page has it, and the person's name in it. */
export async function log(
	at: Server,
	id: string,
): Promise<{ person: string; entries: Entry[] }> {
	const res = await fetch(new URL(`api/agents/${id}/log`, at.url));
	if (!res.ok) throw new Error(`the log: ${res.status}`);
	return (await res.json()) as { person: string; entries: Entry[] };
}
