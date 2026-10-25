// A page to talk with an agent by voice, on a session of the byoa transport.
// Whoever starts creates the session: the page, which then hands the agent
// a prompt with its link, or the agent, which gives the person the page with
// the link as `#session=<link>`. The ElevenLabs key comes encrypted from the
// agent, or typed in, and stays in this browser.
import { Secrets, type Session } from "byoa/participant";
import { Named, Onboard } from "byoa-web/onboard";
import { useSession } from "byoa-web/react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Voice } from "./voice/voice.ts";
import { VoiceBar } from "./voice/voice-bar.tsx";

const KEY = "elevenlabs-key";

export function App() {
	return (
		<Named service="voice.senses.sh">{(name) => <Page name={name} />}</Named>
	);
}

/** The page, taking part under the person's `name`. */
function Page({ name }: { name: string }) {
	const { session, alone, problem, leave } = useSession(name);
	const [key, setKey] = useState(() => localStorage.getItem(KEY));

	useEffect(() => {
		if (!session) return;
		const secrets = new Secrets(session);
		if (!localStorage.getItem(KEY)) void secrets.publish();
		return session.subscribe({
			entry: (entry) =>
				void secrets.open(entry).then((secret) => {
					if (secret?.name !== "elevenlabs") return;
					localStorage.setItem(KEY, secret.value);
					setKey(secret.value);
				}),
		});
	}, [session]);

	if (session && alone) {
		return (
			<Onboard
				name="voice.senses.sh"
				title="Talk with your agent"
				description="Speak to the agent you already use, and hear its answers, here in your browser."
				link={session.link}
				note="The voice runs on ElevenLabs, with your own account."
			/>
		);
	}
	return (
		<main className="mx-auto flex h-dvh max-w-2xl flex-col gap-4 p-4 pb-8">
			<div className="flex items-center gap-2 text-sm text-muted-foreground">
				<span className="flex-1">Keep this page's link secret.</span>
				<Button
					variant="outline"
					size="sm"
					disabled={session === null}
					title="Leave the session: once everyone has left, it is deleted"
					onClick={leave}
				>
					Leave
				</Button>
			</div>
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
		const voice = new Voice(session, session.name, elevenlabs);
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
