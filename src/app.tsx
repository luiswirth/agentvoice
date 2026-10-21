// A page to talk with an agent by voice: a session of the byoa transport, its
// messages, and voice's controls. The agent sets it up, and gives the person a
// link with the session and the ElevenLabs key in its hash,
// `#session=<link>&key=<key>`. A browser sends no hash to any server, and the
// page moves the key into local storage at once, so it never reaches one.
import { LEAVE, Session } from "byoa/client";
import { Onboard } from "byoa/onboard";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { type Entry, spoken } from "./voice/protocol.ts";
import { Voice } from "./voice/voice.ts";
import { VoiceBar } from "./voice/voice-bar.tsx";

const NAME = "person";
const KEY = "elevenlabs-key";

/** Moves a key in the hash into local storage. Registered before React's
 * listener, so that the page sees the key with the hash that brought it. */
function takeKey() {
	const hash = new URLSearchParams(location.hash.slice(1));
	const key = hash.get("key");
	if (!key) return;
	localStorage.setItem(KEY, key);
	hash.delete("key");
	history.replaceState(null, "", `#${hash}`);
}
takeKey();
addEventListener("hashchange", takeKey);

function useSessionLink(): string {
	return useSyncExternalStore(
		(changed) => {
			addEventListener("hashchange", changed);
			return () => removeEventListener("hashchange", changed);
		},
		() => new URLSearchParams(location.hash.slice(1)).get("session") ?? "",
	);
}

export function App() {
	const link = useSessionLink();
	const key = localStorage.getItem(KEY);
	if (!link) {
		return (
			<Onboard
				name="voice.senses.sh"
				title="Talk with your agent"
				description="Speak to the agent you already use, and hear its answers, here in your browser."
				prompt={`Read ${location.origin}/agent.md and start a voice session with me.`}
				note="The voice runs on ElevenLabs, with your own account. Your agent sets up its key with you."
			/>
		);
	}
	return (
		<main className="mx-auto flex h-dvh max-w-2xl flex-col gap-4 p-4">
			{key ? (
				<Talk key={link} link={link} elevenlabs={key} />
			) : (
				<p className="m-auto max-w-sm text-center text-sm text-muted-foreground">
					This browser has no ElevenLabs key yet. Ask your agent for the link
					with the key in it.
				</p>
			)}
		</main>
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
	return (
		<>
			<div className="flex items-center gap-2 text-sm text-muted-foreground">
				<span className="flex-1">
					The page's link is a secret: whoever holds it can talk to your agent.
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
			{problem ? (
				<p className="text-sm text-destructive">{problem}</p>
			) : (
				voice && <VoiceBar voice={voice} />
			)}
		</>
	);
}

/** The messages, and who left, so that the person knows when to leave too. */
function shown(entry: Entry): boolean {
	return spoken(entry) || entry.type === LEAVE;
}
