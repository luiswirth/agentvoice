// A page to try voice on: a session of the byoa transport, its chat
// messages, and voice's controls. The session link is the page's hash, and
// the relay the `relay` parameter, by default a local one while developing,
// else byoa's.
import { create, Session } from "byoa/client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { type Entry, spoken } from "./voice/protocol.ts";
import { Voice } from "./voice/voice.ts";
import { VoiceBar } from "./voice/voice-bar.tsx";

const NAME = "person";
const relay =
	new URLSearchParams(location.search).get("relay") ??
	(import.meta.env.DEV ? "http://localhost:8790" : "https://relay.senses.sh");

export function App() {
	const [key, setKey] = useState(() => localStorage.getItem("elevenlabs-key"));
	const link = useSyncExternalStore(
		(changed) => {
			addEventListener("hashchange", changed);
			return () => removeEventListener("hashchange", changed);
		},
		() => decodeURIComponent(location.hash.slice(1)),
	);
	return (
		<main className="mx-auto flex h-dvh max-w-2xl flex-col gap-4 p-4">
			{key === null ? (
				<KeyForm
					done={(key) => {
						localStorage.setItem("elevenlabs-key", key);
						setKey(key);
					}}
				/>
			) : link ? (
				<Talk key={link} link={link} elevenlabs={key} />
			) : (
				<Button
					className="self-start"
					onClick={async () => {
						location.hash = await create(relay);
					}}
				>
					New session
				</Button>
			)}
		</main>
	);
}

function KeyForm({ done }: { done: (key: string) => void }) {
	const [key, setKey] = useState("");
	return (
		<form
			className="flex flex-col gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				if (key.trim()) done(key.trim());
			}}
		>
			<label className="text-sm text-muted-foreground" htmlFor="key">
				Your ElevenLabs API key. It stays in this browser, and goes only to
				ElevenLabs.
			</label>
			<div className="flex gap-2">
				<input
					id="key"
					type="password"
					className="flex-1 rounded-lg border bg-transparent px-2 text-sm"
					value={key}
					onChange={(event) => setKey(event.target.value)}
				/>
				<Button type="submit">Save</Button>
			</div>
		</form>
	);
}

function Talk({ link, elevenlabs }: { link: string; elevenlabs: string }) {
	const [voice, setVoice] = useState<Voice | null>(null);
	const [session, setSession] = useState<Session | null>(null);
	const [entries, setEntries] = useState<Entry[]>([]);
	const [problem, setProblem] = useState<string | null>(null);
	useEffect(() => {
		const session = new Session(link, NAME);
		const voice = new Voice(session, NAME, elevenlabs);
		const stop = session.subscribe({
			entry: (entry) => setEntries((entries) => [...entries, entry]),
			// The first presence comes with the log so far, which the speaker
			// must not read: only then does the voice appear.
			presence: (presence) => {
				if (!(NAME in presence)) return;
				setVoice(voice);
				setSession(session);
			},
			end: setProblem,
		});
		session.join().catch((error: Error) => setProblem(error.message));
		return () => {
			stop();
			voice.close();
			session.close();
		};
	}, [link, elevenlabs]);
	const prompt = `Talk with me by voice through this byoa session: ${link}\nHow it works: ${location.origin}/agent.md\nAsk me to allow curl once if your harness asks before each command.`;
	return (
		<>
			<div className="flex items-center gap-2 text-sm text-muted-foreground">
				<span className="flex-1">
					The page's link is a secret: whoever holds it can talk to your agent.
				</span>
				<Button
					variant="outline"
					size="sm"
					onClick={() => navigator.clipboard.writeText(prompt)}
				>
					Onboard your agent
				</Button>
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
			<ol className="flex flex-1 flex-col gap-3 overflow-y-auto">
				{entries.filter(spoken).map((entry) => (
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
				))}
			</ol>
			{problem ? (
				<p className="text-sm text-destructive">{problem}</p>
			) : (
				voice && <VoiceBar voice={voice} />
			)}
		</>
	);
}
