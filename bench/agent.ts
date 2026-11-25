// The bench's side of a call: VoiceIO's server from this checkout, over a
// scratch folder of agents' IO, or one already running over this machine's,
// and a scripted agent in voice mode there, as MindIO has an agent's IO.
// `VOICEIO_MINDIO` is the `mindio` both use, `mindio` on the PATH by default.
import { type ChildProcess, spawn } from "node:child_process";
import { watch } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Entry } from "../src/voice/protocol.ts";

const MINDIO = process.env.VOICEIO_MINDIO ?? "mindio";

export type Server = {
	/** Where the page is served. */
	url: string;
	/** The agents' IO, each `<agents>/<agent>`. */
	agents: string;
	close(): Promise<void>;
};

/** The server from this checkout over a scratch folder, serving dist/, or
 * the one at `url`, over this machine's agents. */
export async function server(url?: string): Promise<Server> {
	if (url)
		return {
			url,
			agents: join(homedir(), ".agents/mindio"),
			close: async () => {},
		};
	const root = await mkdtemp(join(tmpdir(), "voiceio-bench-"));
	const agents = join(root, "mindio");
	const child: ChildProcess = spawn(
		process.execPath,
		[
			join(import.meta.dirname, "../server/main.ts"),
			"--port",
			"0",
			"--agents",
			agents,
			"--mindio",
			MINDIO,
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
		agents,
		close: async () => {
			child.kill();
			await rm(root, { recursive: true, force: true });
		},
	};
}

/** The scripted agent, `voiceio-bench`, in voice mode while it lives:
 * it takes in each event of its ear and mouth at once, and answers each
 * speech but a backchannel with `answer`, where there is one, streamed a
 * word at a time `stream` seconds apart where that is given, as a model
 * writes. */
export async function agent(
	at: Server,
	answer: string,
	stream?: number,
): Promise<{ id: string; close(): Promise<void> }> {
	const id = "voiceio-bench";
	const io = join(at.agents, id);
	const inbox = join(io, "inbox");
	for (const dir of ["new", "cur", "tmp"])
		await mkdir(join(inbox, dir), { recursive: true, mode: 0o700 });
	await writeFile(join(io, "voice"), JSON.stringify({ name: "bench" }));
	const fresh = join(inbox, "new");
	let busy = Promise.resolve();
	const take = () => {
		busy = busy.then(async () => {
			for (const file of (await readdir(fresh)).sort()) {
				if (!file.includes(".voice.")) continue;
				const taken = join(inbox, "cur", file);
				await rename(join(fresh, file), taken);
				const text = await readFile(taken, "utf8");
				const backchannel =
					/^\[voice [^\]]*\]\s*(mhm|mm|hmm|yeah|okay|ok|ja)\W*$/i;
				if (answer && text.startsWith("[voice ") && !backchannel.test(text))
					void send(io, answer, stream);
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
			await rm(io, { recursive: true, force: true });
		},
	};
}

/** Says `text` to the mouth, whole, or a word at a time `stream` seconds
 * apart. */
async function send(io: string, text: string, stream?: number): Promise<void> {
	const child = spawn(
		MINDIO,
		["--mindio", io, "send", "--type", "txt", "voice"],
		{
			stdio: ["pipe", "ignore", "inherit"],
		},
	);
	const ended = new Promise((done) => child.on("exit", done));
	if (stream === undefined) child.stdin.end(text);
	else {
		for (const word of text.match(/\S+\s*/g) ?? []) {
			child.stdin.write(word);
			await new Promise((r) => setTimeout(r, stream * 1000));
		}
		child.stdin.end();
	}
	await ended;
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
