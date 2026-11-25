// A page to talk with an agent by voice, served by VoiceIO's server on the
// agent's machine (server/main.ts). The person gives their agent one line,
// which has it read public/agents.md and go into voice mode; the page opens
// the call once it is the only agent in voice mode, and lists them where
// there are several. Their turns go into the agent's inbox, and what the
// agent sends them is read aloud. Speech runs on ElevenLabs, with the
// person's own key, which stays in this browser.

import {
	type ReactNode,
	useEffect,
	useState,
	useSyncExternalStore,
} from "react";
import { checkKey, KeyRefused } from "voiceio";
import { Button } from "@/components/ui/button";
import { type Agent, useCall, watchAgents } from "./agents.ts";
import { Frame } from "./frame.tsx";
import { Call, type Present, type Room } from "./voice/call.tsx";
import { agent as isAgent, speakers, spoken } from "./voice/protocol.ts";
import { Voice, type VoiceState } from "./voice/voice.ts";

const KEY = "elevenlabs-key";
const SERVICE = "VoiceIO";

/** The line the person gives their agent, which reads it on its machine,
 * where this page is served. */
const prompt = () =>
	`Read ${new URL("agents.md", location.href).href} and talk with me by voice.`;

/** Where the page is: the agent in the address, as `#agent=<id>`, or
 * `agents` for the list of them, or nothing for the start, which opens the
 * only agent in voice mode by itself. */
const here = () => {
	if (location.hash === "#agents") return "agents";
	return new URLSearchParams(location.hash.slice(1)).get("agent") ?? "";
};

function go(agent: string) {
	location.hash = new URLSearchParams({ agent }).toString();
}

/** To the list of agents, which opens none by itself. */
function list() {
	location.hash = "agents";
}

function storedKey(): string | null {
	try {
		return localStorage.getItem(KEY);
	} catch {
		return null;
	}
}

export function App() {
	const id = useSyncExternalStore((changed) => {
		addEventListener("hashchange", changed);
		return () => removeEventListener("hashchange", changed);
	}, here);
	const [key, setKey] = useState(storedKey);
	// The key before any call, so that voice is ready as one opens, and the
	// agent's first words are heard.
	if (key === null) return <KeyStep keep={setKey} />;
	if (id === "" || id === "agents") return <Agents open={id === ""} />;
	return (
		<Talk
			key={id}
			id={id}
			elevenlabs={key}
			forgetKey={() => {
				localStorage.removeItem(KEY);
				setKey(null);
			}}
		/>
	);
}

/** The agents in voice mode on this machine, with the line that puts one
 * in it: at the start, the only one opens by itself. */
function Agents({ open }: { open: boolean }) {
	const [agents, setAgents] = useState<Agent[] | null>(null);
	useEffect(() => {
		const stop = new AbortController();
		void watchAgents(setAgents, stop.signal);
		return () => stop.abort();
	}, []);
	const only = agents?.length === 1 ? agents[0] : undefined;
	useEffect(() => {
		if (open && only) go(only.id);
	}, [open, only]);
	if (agents === null) return null;
	return (
		<Frame
			name={SERVICE}
			title={agents.length === 0 ? "Waiting for your agent" : "Talk with"}
			description={
				agents.length === 0
					? "Give your agent this line. Once it is in voice mode, the call opens here, and you can talk."
					: "The agents in voice mode on this machine. Your words go into the agent's inbox, and its answers are read to you."
			}
		>
			{agents.length > 0 && (
				<ul className="flex flex-col gap-1.5">
					{agents.map((agent) => (
						<li key={agent.id}>
							<button
								type="button"
								onClick={() => go(agent.id)}
								className="flex w-full items-baseline gap-3 rounded-2xl border bg-card/40 px-4 py-3 text-left transition hover:border-foreground/30 hover:bg-card/70 focus-visible:ring-3 focus-visible:ring-ring/50 outline-none active:translate-y-px"
							>
								<span className="text-base">{agent.name}</span>
								{agent.name !== agent.id && (
									<span className="truncate font-mono text-xs text-muted-foreground">
										{agent.id}
									</span>
								)}
							</button>
						</li>
					))}
				</ul>
			)}
			<Prompt />
		</Frame>
	);
}

/** The line for the person's agent, to copy. */
function Prompt() {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [copied]);
	return (
		<div className="flex flex-col gap-2 rounded-2xl border bg-card/60 p-2 shadow-2xl shadow-black/20 backdrop-blur">
			<p className="rounded-xl bg-background/80 p-4 font-mono text-sm leading-relaxed wrap-anywhere">
				{prompt()}
			</p>
			<Button
				size="lg"
				variant="outline"
				onClick={() =>
					void navigator.clipboard
						.writeText(prompt())
						.then(() => setCopied(true))
				}
			>
				{copied ? "Copied" : "Copy"}
			</Button>
		</div>
	);
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

/** The call with the agent `id`. */
function Talk({
	id,
	elevenlabs,
	forgetKey,
}: {
	id: string;
	elevenlabs: string;
	forgetKey: () => void;
}) {
	const { seat, entries, participants, problem } = useCall(id);
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
	const people: Present[] = Object.keys(participants)
		.filter((other) => other !== name)
		.map((other) => ({ name: other }));
	// Listening runs only while the agent is in voice mode to hear it.
	const talking = Boolean(state?.ready && people.some((p) => isAgent(p.name)));
	useEffect(() => {
		void voice?.standby(!talking);
	}, [voice, talking]);

	if (problem)
		return (
			<Frame name={SERVICE} title="This call can't start" description={problem}>
				<Actions>
					<Button size="lg" onClick={list}>
						Pick another agent
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
		leave: list,
	};
	return (
		<main className="mx-auto flex h-dvh max-w-6xl flex-col gap-4 px-3 pt-3 pb-6 sm:px-4 sm:pb-8">
			<p className="text-center text-sm text-muted-foreground">
				{people.length === 0
					? `${seat.agent?.name ?? id} is not in voice mode`
					: ""}
			</p>
			<Call voice={voice} room={room} changeKey={forgetKey} />
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
