// A page to talk with an agent by voice, on a session of the byoa transport.
// Whoever starts creates the session: the page, which then hands the agent
// a prompt with its token, or the agent, which gives the person the page with
// the link as `#session=<link>`. The ElevenLabs key comes encrypted from the
// agent, or typed in, and stays in this browser.
import { create, LEAVE, type Presence, Secrets, Session } from "byoa/client";
import { Onboard } from "byoa/onboard";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { type Entry, spoken } from "./voice/protocol.ts";
import { Voice } from "./voice/voice.ts";
import { VoiceBar } from "./voice/voice-bar.tsx";

const NAME = "person";
const KEY = "elevenlabs-key";
const relay =
	new URLSearchParams(location.search).get("relay") ??
	(import.meta.env.DEV ? "http://localhost:8790" : "https://byoa.senses.sh");

function useLink(): string {
	return useSyncExternalStore(
		(changed) => {
			addEventListener("hashchange", changed);
			return () => removeEventListener("hashchange", changed);
		},
		() => new URLSearchParams(location.hash.slice(1)).get("session") ?? "",
	);
}

export function App() {
	const link = useLink();
	const [problem, setProblem] = useState<string | null>(null);
	useEffect(() => {
		if (link) return;
		create(relay)
			.then((link) => {
				location.hash = new URLSearchParams({ session: link }).toString();
			})
			.catch((error: Error) => setProblem(error.message));
	}, [link]);
	if (problem) return <p className="m-auto p-4 text-destructive">{problem}</p>;
	return link ? <Talk key={link} link={link} /> : null;
}

function Talk({ link }: { link: string }) {
	const [session, setSession] = useState<Session | null>(null);
	const [presence, setPresence] = useState<Presence>({});
	const [entries, setEntries] = useState<Entry[]>([]);
	const [key, setKey] = useState(() => localStorage.getItem(KEY));
	const [problem, setProblem] = useState<string | null>(null);

	useEffect(() => {
		const session = new Session(link, NAME);
		const secrets = new Secrets(session);
		const stop = session.subscribe({
			entry: (entry) => {
				setEntries((entries) => [...entries, entry]);
				secrets.open(entry).then((secret) => {
					if (secret?.name !== "elevenlabs") return;
					localStorage.setItem(KEY, secret.value);
					setKey(secret.value);
				});
			},
			presence: (presence) => {
				setPresence(presence);
				// Only once the log so far is in: the speaker must not read it.
				if (NAME in presence) setSession(session);
			},
			end: setProblem,
		});
		session
			.join()
			.then(async () => {
				if (!localStorage.getItem(KEY)) await secrets.publish();
			})
			.catch((error: Error) => setProblem(error.message));
		return () => {
			stop();
			session.close();
		};
	}, [link]);

	const agents = Object.keys(presence).filter((name) => name !== NAME);
	if (session && agents.length === 0 && !entries.some((e) => e.from !== NAME)) {
		return (
			<Onboard
				name="voice.senses.sh"
				title="Talk with your agent"
				description="Speak to the agent you already use, and hear its answers, here in your browser."
				prompt={`Read ${location.origin}/agents.md and join with session token ${new URL(link).pathname.split("/").pop()}`}
				note="The voice runs on ElevenLabs, with your own account."
			/>
		);
	}
	return (
		<main className="mx-auto flex h-dvh max-w-2xl flex-col gap-4 p-4">
			<div className="flex items-center gap-2 text-sm text-muted-foreground">
				<span className="flex-1">
					Keep the token and this page's link secret.
				</span>
				<Button
					variant="outline"
					size="sm"
					disabled={session === null}
					title="Leave the session: once everyone has left, it is deleted"
					onClick={async () => {
						await session?.leave();
						location.hash = "";
					}}
				>
					Leave
				</Button>
			</div>
			<Log entries={entries} />
			{problem ? (
				<p className="text-sm text-destructive">{problem}</p>
			) : key ? (
				session && <Speech session={session} elevenlabs={key} />
			) : (
				<KeyField done={setKey} />
			)}
		</main>
	);
}

function Speech({
	session,
	elevenlabs,
}: {
	session: Session;
	elevenlabs: string;
}) {
	const [voice, setVoice] = useState<Voice | null>(null);
	useEffect(() => {
		const voice = new Voice(session, NAME, elevenlabs);
		setVoice(voice);
		return () => voice.close();
	}, [session, elevenlabs]);
	return voice && <VoiceBar voice={voice} />;
}

/** For an agent that can't send the key encrypted. */
function KeyField({ done }: { done: (key: string) => void }) {
	const [key, setKey] = useState("");
	return (
		<form
			className="flex flex-col gap-2 text-sm text-muted-foreground"
			onSubmit={(event) => {
				event.preventDefault();
				if (!key.trim()) return;
				localStorage.setItem(KEY, key.trim());
				done(key.trim());
			}}
		>
			<span>
				Waiting for your agent to send your ElevenLabs key, or enter it:
			</span>
			<div className="flex gap-2">
				<input
					type="password"
					aria-label="ElevenLabs API key"
					className="flex-1 rounded-lg border bg-transparent px-2"
					value={key}
					onChange={(event) => setKey(event.target.value)}
				/>
				<Button type="submit">Save</Button>
			</div>
		</form>
	);
}

function Log({ entries }: { entries: Entry[] }) {
	return (
		<ol className="flex flex-1 flex-col gap-3 overflow-y-auto">
			{entries.filter(shown).map((entry) =>
				entry.type === LEAVE ? (
					<li
						key={entry.n}
						className="self-center text-xs text-muted-foreground"
					>
						{entry.from === NAME ? "You" : entry.from} left
					</li>
				) : (
					<li
						key={entry.n}
						className={`whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${entry.from === NAME ? "self-end bg-secondary" : "self-start"}`}
					>
						{entry.from !== NAME && (
							<span className="block text-xs text-muted-foreground">
								{entry.from}
							</span>
						)}
						{entry.text}
					</li>
				),
			)}
		</ol>
	);
}

/** The messages, and who left, so that the person knows when to leave too. */
function shown(entry: Entry): boolean {
	return spoken(entry) || entry.type === LEAVE;
}
