// A page to talk with agents by voice, in a session of Vibe Together. The
// person signs in to Vibe Together, by approving the page as an app there,
// picks a session, and talks: their turns go into the session as their
// messages, through agentvoice, and the agents' messages there are read
// aloud. Speech runs on ElevenLabs, with the person's own key, which stays in
// this browser.

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
	refusedToken,
	type Session,
	sessions as sessionsOf,
	signedIn,
	signIn,
	signOut,
} from "./vt.ts";

const KEY = "elevenlabs-key";
const SERVICE = "agentvoice.lwirth.com";

/** The session in the page's address, as `#session=<id>`. */
const sessionInAddress = () =>
	new URLSearchParams(location.hash.slice(1)).get("session") ?? "";

/** The sessions the person picked on this page, which it joins without
 * asking again: one in a link someone else gave them it asks about first. */
const picked = new Set<string>();

const PICKED = "agentvoice-picked";

/** The session in the address, and `picked` after it where the person
 * picked it here, as one string, which React compares. */
const here = () => {
	const id = sessionInAddress();
	return picked.has(id) ? `${id} picked` : id;
};

function go(session: string) {
	if (session) picked.add(session);
	location.hash = session ? new URLSearchParams({ session }).toString() : "";
	dispatchEvent(new Event(PICKED));
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
	// The session, and whether the person picked it here: picking the one
	// already in the address changes nothing of it.
	const [id, chosen] = useSyncExternalStore((changed) => {
		addEventListener("hashchange", changed);
		addEventListener(PICKED, changed);
		return () => {
			removeEventListener("hashchange", changed);
			removeEventListener(PICKED, changed);
		};
	}, here).split(" ");
	const [key, setKey] = useState(storedKey);
	const [notice, setNotice] = useState<string | null>(null);
	const out = () => {
		signOut().then(
			() => setSignedIn(false),
			(error: Error) => setNotice(error.message),
		);
	};
	const page = (() => {
		if (signedIn === null) return null;
		if (!signedIn) return <SignIn done={() => setSignedIn(true)} />;
		if (!id) return <Sessions signOut={out} gone={() => setSignedIn(false)} />;
		if (!chosen) return <Confirm id={id} />;
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
	})();
	return (
		<>
			{page}
			{notice && (
				<div
					role="alert"
					className="fixed inset-x-3 top-3 z-50 mx-auto max-w-md rounded-2xl border bg-card p-4 text-sm text-pretty shadow-2xl"
				>
					{notice}{" "}
					<button
						type="button"
						className="underline underline-offset-4"
						onClick={() => setNotice(null)}
					>
						OK
					</button>
				</div>
			)}
		</>
	);
}

/** A session in the address the person didn't pick here, such as from a
 * link someone gave them: the page names it and asks before it joins, since
 * joining sends what the microphone hears there as the person's words. */
function Confirm({ id }: { id: string }) {
	const [session, setSession] = useState<Session | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	useEffect(() => {
		signedIn()
			.then((c) => c.session(id))
			.then(setSession, (error: Error) => setProblem(error.message));
	}, [id]);
	return (
		<Frame
			name={SERVICE}
			title={session ? `Talk in ${title(session)}?` : "Talk in this session?"}
			description={
				problem ??
				(session
					? `${session.group ? `In ${session.group.name}. ` : ""}What you say there goes in as your messages, and everyone in the session reads them.`
					: "Loading the session…")
			}
		>
			<Actions>
				{session && (
					<Button size="lg" onClick={() => go(id)}>
						Join and talk
					</Button>
				)}
				<Button size="lg" variant="outline" onClick={() => go("")}>
					Pick a session
				</Button>
			</Actions>
		</Frame>
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
					Vibe Together asks you to approve this page as the app "agentvoice".
					It then sends and reads as you in your sessions, and nothing else,
					until you sign out or revoke it there.
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
	const [seen, setSeen] = useState<{
		me: string;
		sessions: Session[];
	} | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: once, as the list opens
	useEffect(() => {
		signedIn()
			.then(async (c) => ({
				me: (await c.me()).name,
				sessions: await sessionsOf(),
			}))
			.then(setSeen)
			.catch((error: Error) => {
				if (refusedToken(error)) gone();
				else setProblem(error.message);
			});
	}, []);
	const sessions = seen?.sessions ?? [];
	const groups = Map.groupBy(
		sessions,
		(session) => session.group?.name ?? "Direct messages",
	);
	return (
		<Frame
			name={SERVICE}
			title="Pick a session"
			description={
				seen
					? `Signed in to Vibe Together as ${seen.me}. Your words go into the session as your messages, and its agents' answers are read to you.`
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
			{seen && (
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
