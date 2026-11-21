/** The page's transport: its own server, on the agents' machine
 * (server/main.ts), which delivers the person's turns into an agent's inbox
 * and gives back what the agent sends them, with the call's log. */

import { useEffect, useState } from "react";
import type { Entry, Participant, Session } from "./voice/protocol.ts";

export type Participants = Record<string, Participant>;

/** An agent in voice mode on the machine. */
export type Agent = { id: string; name: string };

class Refused extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, init);
	const body = (await res.json().catch(() => ({}))) as T & { error?: string };
	if (!res.ok) {
		const message = body.error ?? `${res.status} ${res.statusText}`;
		throw res.status < 500 ? new Refused(message) : new Error(message);
	}
	return body;
}

const backoff = (failures: number) =>
	new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** failures)));

/** The agents in voice mode, kept current while `signal` lasts. */
export async function watchAgents(
	seen: (agents: Agent[]) => void,
	signal: AbortSignal,
): Promise<void> {
	let revision: string | undefined;
	let failures = 0;
	while (!signal.aborted) {
		try {
			const query = revision ? `?${new URLSearchParams({ revision })}` : "";
			const answer = await call<{ revision: string; agents: Agent[] }>(
				`api/agents${query}`,
				{ signal },
			);
			failures = 0;
			revision = answer.revision;
			seen(answer.agents);
		} catch {
			if (signal.aborted) return;
			failures += 1;
			await backoff(failures);
		}
	}
}

type Subscriber = {
	entry?: (entry: Entry) => void;
	participants?: (participants: Participants) => void;
};

type Log = {
	revision: string;
	agent: Agent | null;
	person: string;
	entries: Entry[];
	participants: Participants;
};

/** The person's call with an agent: its log so far, and who is in it, kept
 * current while the page observes it. */
export class Seat implements Session {
	readonly id: string;
	/** The person's name, as the agent has it, once the log is in. */
	name = "";
	agent: Agent | null = null;
	log: Entry[] = [];
	participants: Participants = {};
	private readonly subscribers = new Set<Subscriber>();
	private readonly stop = new AbortController();

	constructor(id: string) {
		this.id = id;
	}

	private path(what: string): string {
		return `api/agents/${encodeURIComponent(this.id)}/${what}`;
	}

	async send(text: string): Promise<void> {
		await call(this.path("turns"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text }),
		});
	}

	subscribe(subscriber: Subscriber): () => void {
		this.subscribers.add(subscriber);
		return () => this.subscribers.delete(subscriber);
	}

	/** Observes the call: reads the log so far, then waits for each change
	 * of it or of who is in it, until closed or refused, which `end` tells. */
	async observe(end: (why: string) => void): Promise<void> {
		let revision: string | undefined;
		let failures = 0;
		const { signal } = this.stop;
		while (!signal.aborted) {
			const after = this.log.at(-1)?.n ?? 0;
			try {
				const query = new URLSearchParams({
					after: String(after),
					...(revision && { revision }),
				});
				const log = await call<Log>(`${this.path("log")}?${query}`, {
					signal,
				});
				failures = 0;
				revision = log.revision;
				this.name = log.person;
				this.agent = log.agent;
				const fresh = log.entries.filter((entry) => entry.n > after);
				this.log = [...this.log, ...fresh];
				this.participants = log.participants;
				for (const entry of fresh)
					for (const s of this.subscribers) s.entry?.(entry);
				for (const s of this.subscribers) s.participants?.(log.participants);
			} catch (error) {
				if (signal.aborted) return;
				if (error instanceof Refused) {
					end(error.message);
					return;
				}
				failures += 1;
				await backoff(failures);
			}
		}
	}

	close(): void {
		this.stop.abort();
		this.subscribers.clear();
	}
}

export type Call = {
	/** The call, once the log so far is in. */
	seat: Seat | null;
	entries: Entry[];
	participants: Participants;
	problem: string | null;
};

/** Takes part in the call with the agent `id` while mounted. */
export function useCall(id: string): Call {
	const [seat, setSeat] = useState<Seat | null>(null);
	const [entries, setEntries] = useState<Entry[]>([]);
	const [participants, setParticipants] = useState<Participants>({});
	const [problem, setProblem] = useState<string | null>(null);

	useEffect(() => {
		setSeat(null);
		setEntries([]);
		setParticipants({});
		setProblem(null);
		const seat = new Seat(id);
		let first = true;
		seat.subscribe({
			entry: () => setEntries(seat.log),
			participants: (participants) => {
				setEntries(seat.log);
				setParticipants(participants);
				// The log so far is in with the first answer.
				if (first) setSeat(seat);
				first = false;
			},
		});
		void seat.observe(setProblem);
		return () => seat.close();
	}, [id]);

	return { seat, entries, participants, problem };
}
