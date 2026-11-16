// Vibe Together for the bench, in Node: the person through agentvoice, by the
// app token `just token` keeps, with the same client library as the page, and
// a scripted agent of theirs through the command line, `vibetogether`, with
// the machine's agent token.
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import init, { Client } from "../src/vt/vibetogether_client.js";

export const SERVER =
	process.env.VIBETOGETHER ?? "https://vibetogether.potentialhedge.com";

/** Where `just token` keeps the app token the bench signs in with. */
export const TOKEN = join(import.meta.dirname, ".cache", "vibetogether-token");

/** The person through agentvoice, by the token `just token` kept. */
export async function person(): Promise<{ client: Client; token: string }> {
	const token = (
		await readFile(TOKEN, "utf8").catch(() => {
			throw new Error("no token: run just token first");
		})
	).trim();
	await init({
		module_or_path: await readFile(
			join(import.meta.dirname, "../src/vt/vibetogether_client_bg.wasm"),
		),
	});
	return { client: new Client(SERVER, token), token };
}

const run = promisify(execFile);

/** The bench's scripted agent, `agentvoice-bench`, of the machine's agent
 * token, created once and kept in `.cache/agent.json`. */
export async function agent(): Promise<Agent> {
	const kept = join(import.meta.dirname, ".cache", "agent.json");
	const json = await readFile(kept, "utf8").catch(async () => {
		const created = (
			await run("vibetogether", ["create-agent", "agentvoice-bench"])
		).stdout;
		await writeFile(kept, created);
		return created;
	});
	const { id, name } = JSON.parse(json) as { id: string; name: string };
	return new Agent(id, name.split("/")[0] ?? "");
}

/** The session the bench plays into, in the person's own group. */
export const BENCH = "agentvoice bench";

export class Agent {
	readonly id: string;
	/** Its person's name, which is their own group's. */
	readonly person: string;
	constructor(id: string, person: string) {
		this.id = id;
		this.person = person;
	}

	private async call(args: string[], input?: string): Promise<string> {
		const child = execFile("vibetogether", ["--agent", this.id, ...args]);
		let out = "";
		child.stdout?.on("data", (d: string) => {
			out += d;
		});
		const done = new Promise<void>((resolve, reject) =>
			child.on("exit", (code) =>
				code === 0
					? resolve()
					: reject(new Error(`vibetogether ${args[0]} exited ${code}`)),
			),
		);
		child.stdin?.end(input ?? "");
		await done;
		return out;
	}

	/** The session of its group named `name`, created where there is none. */
	async session(name: string): Promise<string> {
		const sessions = JSON.parse(await this.call(["sessions"])) as {
			id: string;
			name: string;
			group?: { id: string; name: string };
		}[];
		const found = sessions.find(
			(s) => s.name === name && s.group?.name === this.person,
		);
		if (found) return found.id;
		const groups = JSON.parse(await this.call(["groups"])) as {
			id: string;
			own: boolean;
		}[];
		const own = groups.find((g) => g.own);
		if (!own) throw new Error("the agent sees no own group of its person");
		return (
			JSON.parse(
				await this.call(["create-session", "--group", own.id, name]),
			) as {
				id: string;
			}
		).id;
	}

	join(session: string) {
		return this.call(["join", session]);
	}

	leave(session: string) {
		return this.call(["leave", session]);
	}

	send(session: string, text: string) {
		return this.call(["send", session, "--type", "text/plain"], text);
	}
}
