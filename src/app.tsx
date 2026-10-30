// A page to talk with an agent by voice, on a session of the byoa transport.
// Whoever starts creates the session: the page, which then hands the agent
// a prompt with its link, or the agent, which gives the person the page with
// the link as `#session=<link>`. The ElevenLabs key comes encrypted from the
// agent, or typed in, and stays in this browser; voice running wholly on
// this device needs none.
import { Secrets, type Session } from "byoa/participant";
import { Frame, Named, Onboard } from "byoa-web/onboard";
import { useSession } from "byoa-web/react";
import {
	type ReactNode,
	useEffect,
	useReducer,
	useState,
	useSyncExternalStore,
} from "react";
import { Button } from "@/components/ui/button";
import { checkKey, KeyRefused } from "./voice/elevenlabs.ts";
import {
	chooseEngines,
	chosenEngines,
	needsKey,
	Voice,
} from "./voice/voice.ts";
import { VoiceBar } from "./voice/voice-bar.tsx";

const KEY = "elevenlabs-key";
const SERVICE = "voice.agentic.lwirth.com";

export function App() {
	return (
		<Named service={SERVICE}>
			{(name, rename) => <Page name={name} rename={rename} />}
		</Named>
	);
}

/** The page, taking part under the person's `name`. */
function Page({ name, rename }: { name: string; rename: () => void }) {
	const { session, alone, problem, taken, leave } = useSession(name);
	const [key, setKey] = useState(() => localStorage.getItem(KEY));
	// Why ElevenLabs refused the last key, which asks for another.
	const [refused, setRefused] = useState<string | null>(null);
	// The engines are kept in this browser, where the voice bar changes them.
	const [, rechosen] = useReducer((n: number) => n + 1, 0);

	/** Keeps `candidate` unless ElevenLabs refuses it; a check that fails
	 * for another reason, such as the network, can't tell, so it keeps it. */
	const offer = async (candidate: string) => {
		try {
			await checkKey(candidate);
		} catch (error) {
			if (error instanceof KeyRefused) {
				setRefused(error.message);
				return;
			}
		}
		localStorage.setItem(KEY, candidate);
		setRefused(null);
		setKey(candidate);
	};
	const forget = (why: string) => {
		localStorage.removeItem(KEY);
		setRefused(why);
		setKey(null);
	};

	// Without a key, a public key of its own for the agent to send it to.
	// biome-ignore lint/correctness/useExhaustiveDependencies: offer only sets state
	useEffect(() => {
		if (!session || key) return;
		const secrets = new Secrets(session);
		void secrets.publish();
		return session.subscribe({
			entry: (entry) =>
				void secrets.open(entry).then((secret) => {
					if (secret?.name === "elevenlabs") void offer(secret.value.trim());
				}),
		});
	}, [session, key]);

	if (problem) {
		return taken ? (
			<Frame
				name={SERVICE}
				title="That name is taken here"
				description={`Someone joined this session as ${name} already, maybe you on another device. Join under another name, such as ${name}-phone.`}
			>
				<Actions>
					<Button size="lg" onClick={rename}>
						Choose another name
					</Button>
				</Actions>
			</Frame>
		) : (
			<Frame
				name={SERVICE}
				title="This session can't be joined"
				description={problem}
			>
				<Actions>
					<Button size="lg" onClick={() => void leave()}>
						Start a new session
					</Button>
				</Actions>
			</Frame>
		);
	}
	if (session && alone) {
		return (
			<Onboard
				name={SERVICE}
				title="Talk with your agent"
				description="Speak to the agent you already use, and hear its answers, here in your browser."
				link={session.link}
				person={name}
				note="The voice runs on ElevenLabs, with your own account, or on this device."
			/>
		);
	}
	if (session && !key && needsKey(chosenEngines())) {
		return (
			<KeyStep
				refused={refused}
				offer={offer}
				local={() => {
					chooseEngines({ hearing: "local", speaking: "local" });
					setRefused(null);
					rechosen();
				}}
			/>
		);
	}
	return (
		<main className="mx-auto flex h-dvh max-w-2xl flex-col gap-4 px-2 pt-4 pb-8 sm:px-4">
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
			{session && <Speech session={session} elevenlabs={key} forget={forget} />}
		</main>
	);
}

function Actions({ children }: { children: ReactNode }) {
	return <div className="flex flex-wrap gap-2">{children}</div>;
}

function Speech({
	session,
	elevenlabs,
	forget,
}: {
	session: Session;
	elevenlabs: string | null;
	forget: (why: string) => void;
}) {
	const [voice, setVoice] = useState<Voice | null>(null);
	useEffect(() => {
		const voice = new Voice(session, session.name, elevenlabs);
		setVoice(voice);
		return () => voice.close();
	}, [session, elevenlabs]);
	return (
		voice && (
			<Refusable voice={voice} forget={forget} keyed={elevenlabs !== null} />
		)
	);
}

/** The voice bar, and a way to another key once ElevenLabs refuses this
 * one, or to a key where there is none. */
function Refusable({
	voice,
	forget,
	keyed,
}: {
	voice: Voice;
	forget: (why: string) => void;
	keyed: boolean;
}) {
	const state = useSyncExternalStore(voice.watch, () => voice.state);
	return (
		<>
			<VoiceBar voice={voice} />
			{state.refused && state.error && (
				<div className="flex justify-center">
					<Button variant="outline" onClick={() => forget(state.error ?? "")}>
						{keyed ? "Use another ElevenLabs key" : "Enter an ElevenLabs key"}
					</Button>
				</div>
			)}
		</>
	);
}

/** Asks for the ElevenLabs key, unless the agent sends it first, or for
 * voice to run on this device instead. */
function KeyStep({
	refused,
	offer,
	local,
}: {
	refused: string | null;
	offer: (key: string) => Promise<void>;
	local: () => void;
}) {
	const [draft, setDraft] = useState("");
	const [checking, setChecking] = useState(false);
	const key = draft.trim();
	return (
		<Frame
			name={SERVICE}
			title="Your ElevenLabs key"
			description="This page listens and speaks through ElevenLabs, with your own account. Your agent can send the key, or you enter it here. It goes from this browser straight to ElevenLabs, and stays in this browser."
		>
			<div className="flex flex-col gap-3">
				<form
					className="flex flex-col gap-2 rounded-2xl border bg-card/60 p-2 shadow-2xl shadow-black/20 backdrop-blur sm:flex-row"
					onSubmit={async (event) => {
						event.preventDefault();
						if (!key) return;
						setChecking(true);
						await offer(key);
						setChecking(false);
					}}
				>
					<input
						type="password"
						autoComplete="off"
						aria-label="ElevenLabs API key"
						className="h-11 flex-1 rounded-xl bg-background/80 px-4 font-mono text-base outline-none placeholder:font-sans placeholder:text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
						placeholder="sk_…"
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
					/>
					<button
						type="submit"
						disabled={!key || checking}
						className="h-11 rounded-xl bg-primary px-6 font-medium text-primary-foreground transition-all outline-none hover:bg-primary/85 focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px disabled:opacity-50"
					>
						{checking ? "Checking…" : "Continue"}
					</button>
				</form>
				{refused && <p className="px-2 text-sm text-destructive">{refused}</p>}
			</div>
			<p className="text-sm text-pretty text-muted-foreground">
				No key yet? Create one in{" "}
				<a
					className="text-foreground underline underline-offset-4"
					href="https://elevenlabs.io/app/developers/api-keys"
					target="_blank"
					rel="noreferrer"
				>
					ElevenLabs, under Developers, API Keys
				</a>
				, with Speech to Text and Text to Speech allowed.
			</p>
			<p className="text-sm text-pretty text-muted-foreground">
				Or{" "}
				<button
					type="button"
					className="text-foreground underline underline-offset-4"
					onClick={local}
				>
					run voice on this device
				</button>
				, with no key: it hears and speaks English, and loads about 230 MB once.
			</p>
		</Frame>
	);
}
