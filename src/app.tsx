// A page to talk with agents by voice, in a session of Vibe Together. The
// person signs in to Vibe Together, by approving the page's OTP there, picks a
// session, and talks: their turns go into the session as their messages, and
// the agents' messages there are read aloud. Speech runs on ElevenLabs, with
// the person's own key, which stays in this browser.

import { checkKey, KeyRefused } from "agentvoice";
import {
	type ReactNode,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { Button } from "@/components/ui/button";
import { Frame } from "./frame.tsx";
import { useSession } from "./session.ts";
import { Call, type Present, type Room } from "./voice/call.tsx";
import { agent as isAgent, speakers, spoken } from "./voice/protocol.ts";
import { Voice, type VoiceState } from "./voice/voice.ts";
import {
	client,
	type Overview,
	refusedToken,
	type Session,
	sessionsOf,
	signIn,
	signOut,
} from "./vt.ts";

const KEY = "elevenlabs-key";
const SERVICE = "agentvoice.lwirth.com";

/** The session in the page's address, as `#session=<id>`. */
const sessionInAddress = () =>
	new URLSearchParams(location.hash.slice(1)).get("session") ?? "";

function go(session: string) {
	location.hash = session ? new URLSearchParams({ session }).toString() : "";
}

function storedKey(): string | null {
	try {
		return localStorage.getItem(KEY);
	} catch {
		return null;
	}
}

export function App() {
	// Whether the page holds a token, as far as it knows: a refused one
	// signs it out.
	const [signedIn, setSignedIn] = useState<boolean | null>(null);
	useEffect(() => {
		void client().then((c) => setSignedIn(c !== null));
	}, []);
	const id = useSyncExternalStore((changed) => {
		addEventListener("hashchange", changed);
		return () => removeEventListener("hashchange", changed);
	}, sessionInAddress);
	const [key, setKey] = useState(storedKey);
	const out = () => {
		void signOut().then(() => setSignedIn(false));
	};

	if (signedIn === null) return null;
	if (!signedIn) return <SignIn done={() => setSignedIn(true)} />;
	if (!id) return <Sessions signOut={out} gone={() => setSignedIn(false)} />;
	if (key === null) return <KeyStep keep={setKey} />;
	return (
		<Talk
			key={id}
			id={id}
			elevenlabs={key}
			forgetKey={() => {
				localStorage.removeItem(KEY);
				setKey(null);
			}}
			signOut={out}
		/>
	);
}

/** Signing in: the page asks Vibe Together for an OTP at once, so that the
 * button is a plain link, which a phone's browser opens without a popup
 * blocker in the way, and waits until the person approves it there. An OTP
 * lasts 15 minutes: an expired one is replaced. */
function SignIn({ done }: { done: () => void }) {
	const [link, setLink] = useState<string | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const finished = useRef(done);
	finished.current = done;
	useEffect(() => {
		const stop = new AbortController();
		(async () => {
			while (!stop.signal.aborted) {
				try {
					await signIn(setLink, stop.signal);
					finished.current();
					return;
				} catch (error) {
					if (stop.signal.aborted) return;
					setLink(null);
					setProblem((error as Error).message);
					await new Promise((r) => setTimeout(r, 3000));
				}
			}
		})();
		return () => stop.abort();
	}, []);
	return (
		<Frame
			name={SERVICE}
			title="Talk with your agents"
			description="Speak in a session of Vibe Together, and hear your agents' answers, here in your browser. Sign in to Vibe Together first."
		>
			<section className="flex flex-col gap-3">
				<a
					href={link ?? undefined}
					target="_blank"
					rel="noreferrer"
					aria-disabled={!link}
					className={`flex h-12 items-center justify-center rounded-xl bg-primary px-6 text-base font-medium text-primary-foreground transition-all outline-none hover:bg-primary/85 focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px ${link ? "" : "pointer-events-none opacity-50"}`}
				>
					Sign in with Vibe Together
				</a>
				<p className="px-2 text-sm text-pretty text-muted-foreground">
					Vibe Together asks you to approve this page as "agentvoice". It then
					acts as you, in the sessions you pick here, until you sign out or
					revoke it there.
				</p>
				{problem && <p className="px-2 text-sm text-destructive">{problem}</p>}
			</section>
		</Frame>
	);
}

/** The sessions the person can talk in, by group, the ones that pinged them
 * marked. */
function Sessions({
	signOut,
	gone,
}: {
	signOut: () => void;
	/** The token was refused. */
	gone: () => void;
}) {
	const [overview, setOverview] = useState<Overview | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: once, as the list opens
	useEffect(() => {
		void client()
			.then((c) => c?.overview({}))
			.then((o) => o && setOverview(o))
			.catch((error: Error) => {
				if (refusedToken(error)) gone();
				else setProblem(error.message);
			});
	}, []);
	const sessions = overview ? sessionsOf(overview) : [];
	const groups = Map.groupBy(
		sessions,
		(session) => session.group?.name ?? "Direct messages",
	);
	return (
		<Frame
			name={SERVICE}
			title="Pick a session"
			description={
				overview
					? `Signed in to Vibe Together as ${overview.account.name}. Your words go into the session as your messages, and its agents' answers are read to you.`
					: "Loading your sessions…"
			}
		>
			{problem && <p className="text-sm text-destructive">{problem}</p>}
			<div className="flex flex-col gap-8">
				{[...groups].map(([group, sessions]) => (
					<section key={group} className="flex flex-col gap-2">
						<h2 className="px-2 text-xs tracking-widest text-muted-foreground uppercase">
							{group}
						</h2>
						<ul className="flex flex-col gap-1.5">
							{sessions.map((session) => (
								<li key={session.id}>
									<button
										type="button"
										onClick={() => go(session.id)}
										className="flex w-full items-baseline gap-3 rounded-2xl border bg-card/40 px-4 py-3 text-left transition hover:border-foreground/30 hover:bg-card/70 focus-visible:ring-3 focus-visible:ring-ring/50 outline-none active:translate-y-px"
									>
										<span className="text-base">{title(session)}</span>
										{session.pinged && (
											<span className="text-sm text-primary">pinged you</span>
										)}
									</button>
								</li>
							))}
						</ul>
					</section>
				))}
			</div>
			{overview && (
				<p className="px-2 text-sm text-muted-foreground">
					<button
						type="button"
						className="underline underline-offset-4 hover:text-foreground"
						onClick={signOut}
					>
						Sign out
					</button>
				</p>
			)}
		</Frame>
	);
}

function title(session: Session): string {
	if (session.friend) return session.friend;
	return session.project
		? `${session.project.name} / ${session.name}`
		: session.name;
}

/** The ElevenLabs key, which ElevenLabs checks before it is kept. */
function KeyStep({ keep }: { keep: (key: string) => void }) {
	const [draft, setDraft] = useState("");
	const [checking, setChecking] = useState(false);
	const [refused, setRefused] = useState<string | null>(null);
	const key = draft.trim();
	return (
		<Frame
			name={SERVICE}
			title="Your ElevenLabs key"
			description="Voice runs on ElevenLabs, with your own key: what your microphone hears while someone speaks, and your agents' answers, go to ElevenLabs. The key stays in this browser, and goes only to ElevenLabs."
		>
			<section className="flex flex-col gap-3">
				<form
					className="flex flex-col gap-2 rounded-2xl border bg-card/60 p-2 shadow-2xl shadow-black/20 backdrop-blur sm:flex-row"
					onSubmit={async (event) => {
						event.preventDefault();
						if (!key) return;
						setChecking(true);
						try {
							await checkKey(key);
						} catch (error) {
							// Another failure, such as the network's, can't tell, so
							// the key is kept.
							if (error instanceof KeyRefused) {
								setRefused(error.message);
								setChecking(false);
								return;
							}
						}
						localStorage.setItem(KEY, key);
						keep(key);
					}}
				>
					<input
						type="password"
						autoComplete="off"
						aria-label="ElevenLabs API key"
						className="h-11 flex-1 rounded-xl bg-background/80 px-4 font-mono text-base outline-none placeholder:font-sans placeholder:text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
						placeholder="ElevenLabs key, sk_…"
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
					/>
					<button
						type="submit"
						disabled={!key || checking}
						className="h-11 rounded-xl bg-primary px-6 font-medium text-primary-foreground transition-all outline-none hover:bg-primary/85 focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px disabled:opacity-50"
					>
						{checking ? "Checking…" : "Use this key"}
					</button>
				</form>
				{refused && <p className="px-2 text-sm text-destructive">{refused}</p>}
				<p className="px-2 text-sm text-pretty text-muted-foreground">
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
			</section>
		</Frame>
	);
}

/** The call in the session `id`. */
function Talk({
	id,
	elevenlabs,
	forgetKey,
	signOut,
}: {
	id: string;
	elevenlabs: string;
	forgetKey: () => void;
	signOut: () => void;
}) {
	const { seat, entries, participants, problem } = useSession(id);
	const [voice, setVoice] = useState<Voice | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the key at its start
	useEffect(() => {
		if (!seat) return;
		const voice = new Voice(seat, seat.name, elevenlabs);
		setVoice(voice);
		return () => voice.close();
	}, [seat]);
	useEffect(() => {
		void voice?.setKey(elevenlabs);
	}, [voice, elevenlabs]);
	const state = useVoiceState(voice);
	const name = seat?.name ?? "";
	const people: Present[] = Object.entries(participants)
		.filter(([other]) => other !== name)
		.map(([other, { presence, since }]) => ({
			name: other,
			receiving: presence === "awake" || presence === "asleep",
			since,
			// Vibe Together vouches for every name: an agent's is under its
			// person's account.
			account: other.split("/")[0],
		}));
	// Listening runs only while an agent is in the session to hear it.
	const talking = Boolean(state?.ready && people.some((p) => isAgent(p.name)));
	useEffect(() => {
		void voice?.standby(!talking);
	}, [voice, talking]);

	if (problem)
		return (
			<Frame
				name={SERVICE}
				title="This session can't be joined"
				description={problem}
			>
				<Actions>
					<Button size="lg" onClick={() => go("")}>
						Pick another session
					</Button>
				</Actions>
			</Frame>
		);
	if (!seat || !voice) return null;
	const room: Room = {
		people,
		turns: entries
			.filter(spoken)
			.filter((entry) => entry.from === name || isAgent(entry.from))
			.map((entry) => ({
				n: entry.n,
				from: entry.from,
				mine: entry.from === name,
				text: entry.text,
			})),
		speakers: speakers(entries),
		link: id,
		leave: () => go(""),
	};
	return (
		<main className="mx-auto flex h-dvh max-w-6xl flex-col gap-4 px-3 pt-3 pb-6 sm:px-4 sm:pb-8">
			<p className="text-center text-sm text-muted-foreground">
				{seat.info ? title(seat.info) : ""}
			</p>
			<Call voice={voice} room={room} changeKey={forgetKey} signOut={signOut} />
			{state?.refused && state.error && (
				<div className="flex justify-center">
					<Button variant="outline" onClick={forgetKey}>
						Use another ElevenLabs key
					</Button>
				</div>
			)}
		</main>
	);
}

function useVoiceState(voice: Voice | null): VoiceState | null {
	return useSyncExternalStore(
		(changed) => voice?.watch(changed) ?? (() => {}),
		() => voice?.state ?? null,
	);
}

function Actions({ children }: { children: ReactNode }) {
	return <div className="flex flex-wrap gap-2">{children}</div>;
}
