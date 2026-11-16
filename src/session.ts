/** The Vibe Together session the page talks in, as a React hook: the person
 * joins it, and the page observes its log while the call lasts. */

import { useEffect, useState } from "react";
import type { Session as Voiced } from "./voice/protocol.ts";
import {
	type Entry,
	type Participant,
	refused,
	refusedToken,
	type Session,
	signedIn,
} from "./vt.ts";

export type Participants = Record<string, Participant>;

type Subscriber = {
	entry?: (entry: Entry) => void;
	participants?: (participants: Participants) => void;
};

const backoff = (failures: number) =>
	new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** failures)));

/** The person in a session: its log so far, and who is in it, kept current
 * while the page observes it. */
export class Seat implements Voiced {
	readonly id: string;
	/** The person's name in it, once joined. */
	name = "";
	info: Session | null = null;
	log: Entry[] = [];
	participants: Participants = {};
	private readonly subscribers = new Set<Subscriber>();
	private readonly stop = new AbortController();

	constructor(id: string) {
		this.id = id;
	}

	/** Joins, or does nothing where the person is in already. */
	async join(): Promise<void> {
		const joined = await (await signedIn()).join(this.id);
		this.name = joined.name;
		this.info = joined.session;
	}

	async send(text: string): Promise<void> {
		await (await signedIn()).send(
			this.id,
			"text/plain",
			new TextEncoder().encode(text),
		);
	}

	subscribe(subscriber: Subscriber): () => void {
		this.subscribers.add(subscriber);
		return () => this.subscribers.delete(subscriber);
	}

	/** Observes the session: reads the log so far, then waits for each change
	 * of it or of who is in it, until closed or refused, which `end` tells. */
	async observe(end: (why: string) => void): Promise<void> {
		let revision: string | undefined;
		let failures = 0;
		const { signal } = this.stop;
		while (!signal.aborted) {
			const after = this.log.at(-1)?.n ?? 0;
			try {
				const log = await (await signedIn()).log(
					this.id,
					revision === undefined ? { after } : { after, revision },
					signal,
				);
				failures = 0;
				revision = log.revision;
				const fresh = log.entries.filter((entry) => entry.n > after);
				this.log = [...this.log, ...fresh];
				this.participants = log.participants;
				for (const entry of fresh)
					for (const s of this.subscribers) s.entry?.(entry);
				for (const s of this.subscribers) s.participants?.(log.participants);
			} catch (error) {
				if (signal.aborted) return;
				if (refusedToken(error) || refused(error)) {
					end((error as Error).message);
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

export type PageSession = {
	/** The session, once joined and the log so far is in. */
	seat: Seat | null;
	entries: Entry[];
	participants: Participants;
	problem: string | null;
};

/** Takes part in the session `id` while mounted. */
export function useSession(id: string): PageSession {
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
		seat
			.join()
			.then(() => seat.observe(setProblem))
			.catch((error: Error) => {
				refusedToken(error);
				setProblem(error.message);
			});
		return () => seat.close();
	}, [id]);

	return { seat, entries, participants, problem };
}
