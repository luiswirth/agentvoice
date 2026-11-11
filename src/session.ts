/** The session the page takes part in, as a React hook. */

import {
	create,
	type Entry,
	type Presence,
	RelayError,
	Session,
} from "agentwire/participant";
import { useEffect, useState, useSyncExternalStore } from "react";
import { defaultRelay } from "./onboard.tsx";

export type PageSession = {
	/** The session's link, from the page's address, as `#session=<link>`. */
	link: string;
	/** The session, once joined and the log so far is in. */
	session: Session | null;
	/** Every entry so far, the page's own included. */
	entries: Entry[];
	presence: Presence;
	/** Whether nobody else has joined yet. */
	alone: boolean;
	problem: string | null;
	/** Whether the problem is that the page's name is taken in the session,
	 * by someone else or by this person on another device. */
	taken: boolean;
	/** Leaves, and starts a new session. */
	leave(): Promise<void>;
};

/** The relay: the one in the page's address as `?relay=<url>`, or else the
 * local one while developing, and the default relay once deployed. */
export const relay =
	new URLSearchParams(location.search).get("relay") ??
	(location.hostname === "localhost" ? "http://localhost:8790" : defaultRelay);

const linkOf = () =>
	new URLSearchParams(location.hash.slice(1)).get("session") ?? "";

/** Where the page keeps its own link for a session and a name, so that a
 * reload, or the link opened again, joins as the same participant. Kept after
 * leaving too, since the name stays taken and only this link joins again.
 * Not in the address, which the person shares. */
const kept = (link: string, name: string) => `agentvoice ${link} ${name}`;

/** The join on its way for each kept link, which a page mounted again waits
 * for, as under React's StrictMode: a second join without the link the first
 * brings would find the name taken. */
const joining = new Map<string, Promise<void>>();

/** Takes part as `name` in the session in the page's address, or, without
 * one, in a new session on the relay, which then goes into the address. */
export function useSession(name: string): PageSession {
	const link = useSyncExternalStore((changed) => {
		addEventListener("hashchange", changed);
		return () => removeEventListener("hashchange", changed);
	}, linkOf);
	const [session, setSession] = useState<Session | null>(null);
	const [entries, setEntries] = useState<Entry[]>([]);
	const [presence, setPresence] = useState<Presence>({});
	const [problem, setProblem] = useState<string | null>(null);
	const [taken, setTaken] = useState(false);

	useEffect(() => {
		setSession(null);
		setEntries([]);
		setPresence({});
		setProblem(null);
		setTaken(false);
		if (!link) {
			create(relay)
				.then((link) => {
					location.hash = new URLSearchParams({ session: link }).toString();
				})
				.catch((error: Error) => setProblem(error.message));
			return;
		}
		const key = kept(link, name);
		let session: Session | null = null;
		let stop = () => {};
		let gone = false;
		const join = (joining.get(key) ?? Promise.resolve()).then(async () => {
			if (gone) return;
			const joined = new Session(link, name, localStorage.getItem(key));
			session = joined;
			stop = joined.subscribe({
				entry: () => setEntries([...joined.log]),
				presence: (presence) => {
					setPresence(presence);
					if (name in presence) setSession(joined);
				},
				end: setProblem,
			});
			try {
				await joined.join();
				if (joined.me) localStorage.setItem(key, joined.me);
			} catch (error) {
				if (gone || !(error instanceof Error)) return;
				setProblem(error.message);
				setTaken(error instanceof RelayError && error.status === 409);
			}
		});
		joining.set(key, join);
		void join.then(() => {
			if (joining.get(key) === join) joining.delete(key);
		});
		return () => {
			gone = true;
			stop();
			session?.close();
		};
	}, [link, name]);

	return {
		link,
		session,
		entries,
		presence,
		alone: !entries.some((entry) => entry.from !== name),
		problem,
		taken,
		leave: async () => {
			await session?.leave();
			location.hash = "";
		},
	};
}
