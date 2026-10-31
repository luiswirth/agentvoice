// A page to talk with an agent by voice, on a session of the polylogue transport.
// Whoever starts creates the session: the page, which then hands the agent
// a prompt with its link, or the agent, which gives the person the page with
// the link as `#session=<link>`. The ElevenLabs key comes encrypted from the
// agent, or typed in, and stays in this browser; the local tier needs none.
import { type Entry, LEAVE, Secrets } from "polylogue/participant";
import { Frame, Named, Onboard } from "polylogue-web/onboard";
import { useSession } from "polylogue-web/react";
import {
	type ReactNode,
	useEffect,
	useState,
	useSyncExternalStore,
} from "react";
import { Button } from "@/components/ui/button";
import { checkKey, KeyRefused } from "./voice/elevenlabs.ts";
import type { Tier } from "./voice/engines.ts";
import { agent as isAgent, spoken } from "./voice/protocol.ts";
import {
	chooseTier,
	chosenTier,
	Voice,
	type VoiceState,
} from "./voice/voice.ts";
import { type Present, type Room, VoiceBar } from "./voice/voice-bar.tsx";

const KEY = "elevenlabs-key";
const SERVICE = "voice.agentics.lwirth.com";
/** What the engine is doing before it offers, as public/engine.md has it. */
const STATUS = "application/vnd.polylogue.engine.status+json";
/** What an engine sends once it is ready. This and its status are what only
 * an engine sends, which marks a participant as one: the pages send the
 * extension's requests too. */
const OFFER = "application/vnd.polylogue.engine.offer+json";

/** The text of a status entry's payload, empty where it has none. */
function statusText(payload: string): string {
	try {
		const { text } = JSON.parse(payload) as { text?: unknown };
		return typeof text === "string" ? text : "";
	} catch {
		return "";
	}
}

export function App() {
	return (
		<Named service={SERVICE}>
			{(name, rename) => <Page name={name} rename={rename} />}
		</Named>
	);
}

/** The tiers, as the person chooses between them before their agent comes. */
const TIERS = [
	{
		id: "local",
		title: "Local",
		description:
			"Open speech models on a machine your agent can act on. Your agent sets them up.",
		facts: ["Free", "No account", "English", "1 GB download, once"],
		goal: "set up voice on the local tier so we can talk",
	},
	{
		id: "elevenlabs",
		title: "ElevenLabs",
		description:
			"Hosted speech models, through your own ElevenLabs account. Your agent can send its key.",
		facts: ["Higher quality", "Many languages", "Paid per use", "Needs a key"],
		goal: "set up voice on the ElevenLabs tier so we can talk",
	},
];

/** The page, taking part under the person's `name`. */
function Page({ name, rename }: { name: string; rename: () => void }) {
	const { session, entries, presence, problem, taken, leave } =
		useSession(name);
	const [key, setKey] = useState(() => localStorage.getItem(KEY));
	// The entry that brought the key, if the agent sent it.
	const [keyEntry, setKeyEntry] = useState<number | undefined>();
	// Why ElevenLabs refused the last key, which asks for another.
	const [refused, setRefused] = useState<string | null>(null);
	// The tier as chosen in this browser, local until the person chooses.
	const [tier, setTier] = useState(chosenTier);

	/** Keeps `candidate` unless ElevenLabs refuses it; a check that fails
	 * for another reason, such as the network, can't tell, so it keeps it. */
	const offer = async (candidate: string, after?: number) => {
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
		setKeyEntry(after);
		setKey(candidate);
	};
	const forget = (why: string) => {
		localStorage.removeItem(KEY);
		setRefused(why);
		setKey(null);
	};

	// The voice lives as long as the session, so that the agent learns the
	// tier from its modes while it sets up; a key that comes later is given
	// to it.
	const [voice, setVoice] = useState<Voice | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the key at its start
	useEffect(() => {
		if (!session) return;
		const voice = new Voice(session, session.name, key);
		setVoice(voice);
		return () => voice.close();
	}, [session]);
	// The voice gets the key from here, the one place it is kept, so that a
	// key that came before the voice did, or through a callback made before
	// it, still reaches it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the entry comes with the key
	useEffect(() => {
		void voice?.setKey(key, keyEntry);
	}, [voice, key]);
	const state = useVoiceState(voice);
	const choose = (chosen: Tier) => {
		setRefused(null);
		setTier(chosen);
		if (voice) void voice.setTier(chosen);
		else chooseTier(chosen);
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
					if (secret?.name === "elevenlabs")
						void offer(secret.value.trim(), entry.n);
				}),
		});
	}, [session, key]);

	// Three states, which the presence decides, on one page that changes in
	// place until talking: onboarding until an agent came, waiting for it
	// while it joins and sets voice up, or after it left, and talking once an
	// agent is here and voice is ready. Copying the prompt only copies it.
	// The tier is chosen while onboarding, and is a setting while talking.
	const current = state?.tier ?? tier;
	const room = session ? roomOf(name, entries, presence) : undefined;
	const agent = room?.people.some((person) => !person.engine) ?? false;
	const talking = Boolean(session && voice && state?.ready && agent);
	// Listening runs only while talking.
	useEffect(() => {
		voice?.standby(!talking);
	}, [voice, talking]);
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
	// Until the page is in the presence, it can't tell who is here.
	if (session && !room) return null;
	if (session && room && !talking) {
		const here = room.people.find((person) => !person.engine)?.name ?? null;
		// Onboarding until an agent came into this session, as before a reload.
		const came = here !== null || room.left !== null;
		return (
			<Onboard
				name={SERVICE}
				title={
					here
						? "Setting up"
						: room.left
							? "Your agent left"
							: "Talk with your agent"
				}
				description={
					here
						? current === "local"
							? "Your agent is starting the speech models on a machine it can act on. Its steps show here."
							: "Voice runs on ElevenLabs, with your own key. Your agent's steps show here."
						: room.left
							? `${label(room.left)} left the session. To talk again, give your agent the prompt.`
							: "Speak to the agent you already use, and hear its answers, here in your browser. First choose where the speech models run."
				}
				link={session.link}
				choice={{
					// The key can be entered as ElevenLabs is chosen, before the
					// agent comes, and stays in place once the choice folds.
					options: TIERS.map((option) =>
						option.id === "elevenlabs"
							? {
									...option,
									detail: key ? (
										<p className="px-2 text-sm text-muted-foreground">
											Your ElevenLabs key is kept in this browser.
										</p>
									) : (
										<KeyStep refused={refused} offer={offer} />
									),
								}
							: option,
					),
					chosen: current,
					choose: (id) => choose(id as Tier),
					folded: came,
				}}
				person={name}
			>
				<Waiting
					name={name}
					entries={entries}
					agent={here}
					switchTier={
						came
							? () => choose(current === "local" ? "elevenlabs" : "local")
							: undefined
					}
					local={current === "local"}
				/>
			</Onboard>
		);
	}
	return (
		<main className="mx-auto flex h-dvh max-w-6xl flex-col gap-4 px-3 pt-3 pb-6 sm:px-4 sm:pb-8">
			{voice && (
				<Refusable
					voice={voice}
					forget={forget}
					keyed={key !== null}
					room={
						session && room
							? {
									people: room.people,
									turns: entries
										.filter(spoken)
										.filter(
											(entry) => entry.from === name || isAgent(entry.from),
										)
										.map((entry) => ({
											n: entry.n,
											from: entry.from,
											mine: entry.from === name,
											text: entry.text,
										})),
									link: session.link,
									leave: () => void leave(),
								}
							: undefined
					}
				/>
			)}
		</main>
	);
}

/** The session as the voice page shows it: the others in it now, and,
 * once everyone to talk with left, who left last. An engine is no one to
 * talk with. */
function roomOf(
	name: string,
	entries: Entry[],
	presence: Record<string, { receiving: boolean; since?: string }>,
): { people: Present[]; left: string | null } | undefined {
	const engines = new Set(
		entries
			.filter((e) => e.type.startsWith(OFFER) || e.type.startsWith(STATUS))
			.map((e) => e.from),
	);
	// Until the page itself is in the presence, it holds no one yet.
	if (!(name in presence)) return undefined;
	const people = Object.entries(presence)
		.filter(([other]) => other !== name)
		.map(([other, { receiving, since }]) => ({
			name: other,
			receiving,
			since,
			engine: engines.has(other),
		}));
	const gone = people.every((person) => person.engine)
		? entries.findLast(
				(e) =>
					e.type.startsWith(LEAVE) && e.from !== name && !engines.has(e.from),
			)
		: undefined;
	return { people, left: gone?.from ?? null };
}

/** A name in the session as the person reads it: without the person's own
 * prefix, which every agent they invite carries. */
function label(name: string): string {
	return name.slice(name.indexOf("/") + 1);
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

/** The voice bar, and a way to another key once ElevenLabs refuses this
 * one, or to a key where there is none. */
function Refusable({
	voice,
	forget,
	keyed,
	room,
}: {
	voice: Voice;
	forget: (why: string) => void;
	keyed: boolean;
	room?: Room | undefined;
}) {
	const state = useSyncExternalStore(voice.watch, () => voice.state);
	return (
		<>
			<VoiceBar
				voice={voice}
				room={room}
				changeKey={keyed ? () => forget("") : undefined}
			/>
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

/** Under the prompt, what the agent does: joining, then while it sets
 * voice up, what it narrates, as text until there is a voice, with the
 * engine's latest status in its place. Once the choice of tier is settled, a
 * way to the other one. */
function Waiting({
	name,
	entries,
	agent,
	local,
	switchTier,
}: {
	name: string;
	entries: Entry[];
	/** The agent here now, by its name. */
	agent: string | null;
	local: boolean;
	/** To the other tier, which the agent then sets up. */
	switchTier?: (() => void) | undefined;
}) {
	// What happened since the agent last joined, not before an earlier one left.
	const since =
		entries.findLast(
			(entry) => entry.type.startsWith(LEAVE) && entry.from !== name,
		)?.n ?? -1;
	const recent = entries.filter((entry) => entry.n > since);
	const status = recent.findLast(
		(entry) => entry.type.startsWith(STATUS) && entry.text !== undefined,
	);
	const said = recent.filter(
		(entry): entry is Entry & { text: string } =>
			(entry.from !== name && spoken(entry)) || entry === status,
	);
	return (
		<>
			<ol className="flex flex-col gap-3 rounded-2xl border bg-card/40 p-5">
				{agent ? (
					<>
						<Step done>{label(agent)} joined.</Step>
						{said.map((entry, i) => (
							<Step key={entry.n} done={i < said.length - 1}>
								{entry === status ? statusText(entry.text) : entry.text}
							</Step>
						))}
						{said.length === 0 && <Step>Waiting for its first step…</Step>}
					</>
				) : (
					<Step>Waiting for your agent to join…</Step>
				)}
			</ol>
			{switchTier && (
				<p className="-mt-6 px-2 text-sm text-muted-foreground">
					<button
						type="button"
						className="underline underline-offset-4 hover:text-foreground"
						onClick={switchTier}
					>
						{local ? "Use ElevenLabs instead" : "Use local models instead"}
					</button>
					, and your agent sets that up.
				</p>
			)}
		</>
	);
}

function Step({
	done = false,
	children,
}: {
	done?: boolean;
	children: ReactNode;
}) {
	return (
		<li className="flex items-baseline gap-3">
			<span
				aria-hidden
				className={`size-2 shrink-0 translate-y-[-1px] rounded-full ${done ? "bg-muted-foreground/50" : "animate-pulse bg-primary shadow-[0_0_12px_var(--primary)]"}`}
			/>
			<span className={done ? "text-muted-foreground" : "text-foreground"}>
				{children}
			</span>
		</li>
	);
}

/** The ElevenLabs key, unless the agent sends it first. */
function KeyStep({
	refused,
	offer,
}: {
	refused: string | null;
	offer: (key: string) => Promise<void>;
}) {
	const [draft, setDraft] = useState("");
	const [checking, setChecking] = useState(false);
	const key = draft.trim();
	return (
		<section className="flex flex-col gap-3">
			<p className="px-2 text-sm text-pretty text-muted-foreground">
				Your agent can send your ElevenLabs key, encrypted so that only this
				page can read it. Or enter it here. It stays in this browser, and goes
				only to ElevenLabs.
			</p>
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
	);
}
