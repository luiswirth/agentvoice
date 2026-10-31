// Voice as two things: the stage, to read from across the room, and the
// player, to act on, as a media player's now-playing panel. The stage shows
// one thing large: the person's words once there are any, else who has the
// floor. It shows only while talking: once the agent left, the page is the
// one from before it joined. The player is one
// card of layers, from what changes least to what is pressed most: the
// session, who is here and leaving it; the words, what happens to the person's
// words, the same with auto-send on and off, with Delete and Send, or the words
// just deleted or not sent, with the way back; and the transport.
//
// The transport is a media player's playback bar: one fixed row of two halves,
// listening on the left and speaking on the right, mirrored. Each half has one
// switch at its end and the controls that act on what it holds: the person's
// words not yet sent, the agent's message being read. A switch that is on is
// lit quietly, and brightly only as loud as its voice really sounds. Beside
// listening, auto-send only decides whether a turn goes out by itself as the
// person pauses: the microphone always just listens or stops.
//
// The page is mostly open in the background, so it shows one thing loud: who
// has the floor, as a word and as light, the person's warm and the agent's
// cool. The agent's words belong to its harness. What is set once, such as the
// tier, waits behind the settings. The system's media controls work it too,
// so that it needs no looking at.
import {
	Check,
	Copy,
	CornerDownLeft,
	Cpu,
	Download,
	LogOut,
	Mic,
	MicOff,
	Pause,
	Play,
	RotateCcw,
	SkipForward,
	SlidersHorizontal,
	Trash2,
	Undo2,
	Volume2,
	VolumeX,
	X,
} from "lucide-react";
import {
	type CSSProperties,
	type ReactNode,
	type RefObject,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import type { Progress } from "./activity.ts";
import { showMedia } from "./media.ts";
import type { Voice, VoiceState } from "./voice.ts";

/** Someone else in the session, as its presence has them. */
export type Present = {
	name: string;
	/** Whether a receive of theirs waits: an agent between turns, listening. */
	receiving: boolean;
	/** If not receiving, since when. */
	since?: string | undefined;
	/** Whether it is a speech engine rather than someone to talk with. */
	engine: boolean;
};

/** The session as the page sees it. */
export type Room = {
	/** The others in it now. */
	people: Present[];
	link: string;
	leave: () => void;
};

export function VoiceBar({
	voice,
	room,
	changeKey,
}: {
	voice: Voice;
	room?: Room | undefined;
	/** Asks for another ElevenLabs key, from the settings. */
	changeKey?: (() => void) | undefined;
}) {
	const state = useSyncExternalStore(voice.watch, () => voice.state);
	const root = useRef<HTMLDivElement>(null);
	const [settings, setSettings] = useState(false);
	useLevels(voice, root);
	useShortcuts(voice, state, settings);
	const now = floor(state);
	useEffect(() => {
		showMedia(said(state) || now.word, mode(state));
	}, [state, now.word]);
	return (
		<div
			ref={root}
			className="relative flex min-h-0 flex-1 flex-col items-center gap-4"
		>
			<Aura
				you={state.listener}
				agent={state.speaker}
				working={state.progress === "working" && state.reading === null}
			/>
			<Stage voice={voice} state={state} />
			<section
				aria-label="Player"
				className="flex w-full max-w-[30rem] shrink-0 flex-col rounded-[2rem] border border-white/10 bg-neutral-950/55 p-2 shadow-2xl shadow-black/60 backdrop-blur-xl"
			>
				<header className="flex h-10 items-center gap-1 pl-3">
					<People people={room?.people ?? []} progress={state.progress} />
					{room && <Leave leave={room.leave} />}
					<button
						type="button"
						title="Settings"
						aria-label="Settings"
						aria-haspopup="dialog"
						className="grid size-10 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-white/10 hover:text-foreground [&_svg]:size-4"
						onClick={() => setSettings(true)}
					>
						<SlidersHorizontal />
					</button>
				</header>
				<div className="mx-3 h-px bg-white/[0.07]" />
				{state.error && (
					<p className="px-3 pt-2 text-sm text-pretty text-destructive">
						{state.error}
					</p>
				)}
				<Line voice={voice} state={state} />
				<Bar voice={voice} state={state} />
			</section>
			<Settings
				open={settings}
				close={() => setSettings(false)}
				voice={voice}
				state={state}
				link={room?.link}
				changeKey={changeKey}
			/>
		</div>
	);
}

function mode({ listener, speaker }: VoiceState): string {
	if (listener && speaker) return "Conversation";
	if (listener) return "Dictation";
	if (speaker) return "Read aloud";
	return "Voice off";
}

function said(state: VoiceState): string {
	return [state.draft, state.hearing].filter(Boolean).join(" ");
}

type Tone = "you" | "agent" | "none";

/** Who has the floor, as one word, in the colour of whoever has it, with a
 * line on what that means. */
function floor(state: VoiceState): {
	word: string;
	tone: Tone;
	hint: string;
} {
	if (state.hearing)
		return {
			word: `Hearing ${who(state)?.name ?? "you"}`,
			tone: "you",
			hint: "",
		};
	// The browser holds the page's sound until a tap or a key on it, as
	// after a reload: until then the agent can't be heard, nor the cues.
	if (state.blocked)
		return {
			word: "Tap to hear",
			tone: "agent",
			hint: "Your browser keeps this page quiet until you tap or click it, or press a key.",
		};
	if (state.reading !== null)
		return state.held
			? { word: "Paused", tone: "agent", hint: "Press play to hear the rest." }
			: {
					word: "Speaking",
					tone: "agent",
					hint: state.listener
						? "Speak to cut in: your agent pauses for you."
						: "Press pause to hold it.",
				};
	// Where the words go, the line above the bar says.
	if (state.listener) return { word: "Listening", tone: "you", hint: "" };
	if (state.speaker)
		return {
			word: "Ready",
			tone: "agent",
			hint: "Your agent's messages are read aloud as they arrive.",
		};
	return {
		word: "Off",
		tone: "none",
		hint: "Turn on listening, speaking, or both.",
	};
}

/** Who is heard now, once the agent named any voice: by name, or by number
 * for a voice it didn't name, which can't take the floor. */
function who({
	names,
	voice,
}: VoiceState): { name: string; named: boolean } | null {
	if (Object.keys(names).length === 0 || voice === undefined) return null;
	const name = voice === null ? undefined : names[voice];
	if (name !== undefined) return { name, named: true };
	return {
		name: voice === null ? "new voice" : `voice ${voice}`,
		named: false,
	};
}

/** The levels of both voices, eased, as the CSS variables `--you-level` and
 * `--agent-level` on `root`, and how much of the agent's message was heard as
 * `--agent-progress`. */
function useLevels(voice: Voice, root: RefObject<HTMLDivElement | null>) {
	useEffect(() => {
		// Rises fast and falls slowly, as a meter does.
		const ease = (from: number, to: number) =>
			from + (to - from) * (to > from ? 0.5 : 0.1);
		let you = 0;
		let agent = 0;
		let frame = requestAnimationFrame(function tick() {
			frame = requestAnimationFrame(tick);
			you = ease(you, voice.state.listener ? voice.state.level : 0);
			agent = ease(agent, voice.speakerLevel());
			root.current?.style.setProperty("--you-level", you.toFixed(3));
			root.current?.style.setProperty("--agent-level", agent.toFixed(3));
			root.current?.style.setProperty(
				"--agent-progress",
				voice.speakerProgress().toFixed(4),
			);
		});
		return () => cancelAnimationFrame(frame);
	}, [voice, root]);
}

/** Both voices as light behind the page, faint while on and brighter as
 * each is louder, the agent's breathing while it works. */
function Aura({
	you,
	agent,
	working,
}: {
	you: boolean;
	agent: boolean;
	working: boolean;
}) {
	const glow = (
		color: string,
		level: string,
		at: string,
		on: boolean,
	): CSSProperties => ({
		left: at,
		background: `radial-gradient(closest-side, color-mix(in oklch, var(${color}) 45%, transparent), transparent)`,
		opacity: `calc(${on ? 0.12 : 0} + var(${level}, 0) * 0.75)`,
		transform: `translate(-50%, 50%) scale(calc(0.85 + var(${level}, 0) * 0.35))`,
	});
	return (
		<div
			aria-hidden
			className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
		>
			<div
				className="absolute bottom-0 h-[70vh] w-[90vmax]"
				style={glow("--you", "--you-level", "25%", you)}
			/>
			<div
				className={`absolute bottom-0 h-[70vh] w-[90vmax] ${working ? "animate-[breathe_2.4s_ease-in-out_infinite]" : ""}`}
				style={glow("--agent", "--agent-level", "75%", agent || working)}
			/>
		</div>
	);
}

/** The middle of the page: the person's words once there are any, else who
 * has the floor. */
function Stage({ voice, state }: { voice: Voice; state: VoiceState }) {
	if (state.draft || state.hearing)
		return <Words voice={voice} state={state} />;
	return <Floor state={state} />;
}

/** Who has the floor, large enough to read from across the room, with how
 * much of the agent's message was heard while it is read. */
function Floor({ state }: { state: VoiceState }) {
	const { word, tone, hint } = floor(state);
	const color =
		tone === "none"
			? "var(--muted-foreground)"
			: `var(--${tone === "you" ? "you" : "agent"})`;
	return (
		<div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-4 text-center">
			<p
				aria-live="polite"
				className="text-5xl font-extralight tracking-tight transition-colors duration-500 sm:text-6xl"
				style={{
					color: `color-mix(in oklch, ${color} 85%, white)`,
					textShadow:
						tone === "none"
							? undefined
							: `0 0 40px color-mix(in oklch, ${color} 45%, transparent)`,
				}}
			>
				{word}
			</p>
			{state.reading !== null && !state.blocked && (
				<div
					aria-hidden
					className="h-0.5 w-48 animate-[arrive_0.4s_ease-out] overflow-hidden rounded-full bg-white/10"
				>
					<div
						className="h-full origin-left rounded-full bg-agent shadow-[0_0_8px_var(--agent)]"
						style={{ transform: "scaleX(var(--agent-progress, 0))" }}
					/>
				</div>
			)}
			<p className="max-w-sm text-base text-balance text-muted-foreground/70">
				{hint}
			</p>
		</div>
	);
}

/** The person's words, large, as one text: what is still being heard follows
 * the draft, quieter, and the draft can be edited once nothing more is being
 * heard into it. */
function Words({ voice, state }: { voice: Voice; state: VoiceState }) {
	return (
		<div className="flex min-h-0 w-full max-w-2xl flex-1 flex-col pt-10 text-2xl sm:pt-16 leading-snug font-light sm:text-3xl">
			{state.hearing ? (
				<p className="min-h-0 flex-1 overflow-y-auto text-pretty">
					{state.draft && <>{state.draft} </>}
					<span className="text-foreground/55">{state.hearing}</span>
				</p>
			) : (
				<textarea
					aria-label="What you said, to edit before sending"
					className="min-h-0 flex-1 resize-none bg-transparent text-pretty outline-none"
					value={state.draft}
					onChange={(event) => voice.setDraft(event.target.value)}
				/>
			)}
		</div>
	);
}

/** The words' line, right above the bar, in one place whatever the mode: on
 * the left what happens to the person's words, on the right what acts on them.
 * With words, where they go, with Delete and Send; else the words just not
 * sent, or just deleted, with the way back; else only where words would go. */
function Line({ voice, state }: { voice: Voice; state: VoiceState }) {
	const words = Boolean(state.draft || state.hearing);
	let text: ReactNode = <Status state={state} />;
	let actions: ReactNode = null;
	if (words)
		actions = (
			<>
				<Action
					label="Delete it (Escape): Undo brings it back"
					onClick={() => voice.clear()}
				>
					<Trash2 />
					Delete
				</Action>
				<SendButton voice={voice} />
			</>
		);
	else if (state.missed) {
		const why = {
			echo: "sounded like your agent",
			quiet: "too quiet",
			backchannel: "said while your agent spoke",
		}[state.missed.why];
		text = (
			<Note>
				Not sent, {why}: “{state.missed.text}”
			</Note>
		);
		actions = (
			<Action
				label="Send it to your agent, as yours"
				onClick={() => voice.sendMissed()}
			>
				<CornerDownLeft />
				Send
			</Action>
		);
	} else if (state.dropped) {
		text = (
			<Note>
				Deleted:{" "}
				<span className="line-through decoration-muted-foreground/50">
					{state.dropped}
				</span>
			</Note>
		);
		actions = (
			<Action label="Bring your words back" onClick={() => voice.undo()}>
				<Undo2 />
				Undo
			</Action>
		);
	}
	return (
		<div className="flex h-12 w-full shrink-0 items-center gap-2 pr-1 pl-3 text-sm">
			{text}
			<div className="flex shrink-0 items-center gap-1 sm:gap-2">{actions}</div>
		</div>
	);
}

/** Where the person's words go: whether more are heard into them, and
 * whether they go out by themselves; and once the agent named any voice,
 * whose voice is heard now, by name, or by number where it can't cut in. */
function Status({ state }: { state: VoiceState }) {
	const voice = state.hearing ? who(state) : null;
	const where = !state.listener
		? state.hearing
			? "Finishing your words…"
			: "Microphone off"
		: state.autoEnd
			? "Sends as you pause"
			: "Waits for Send";
	const lit = state.listener && (voice?.named ?? true);
	return (
		<p
			aria-live="polite"
			className="mr-auto flex min-w-0 items-center gap-2 text-muted-foreground"
		>
			<span
				aria-hidden
				className={`size-2 shrink-0 rounded-full ${lit ? "bg-you" : "bg-white/25"}`}
				style={
					lit
						? {
								boxShadow:
									"0 0 calc(2px + var(--you-level, 0) * 10px) var(--you)",
							}
						: undefined
				}
			/>
			{voice && (
				<span
					className={`shrink-0 text-xs tracking-widest uppercase ${voice.named ? "text-foreground" : "text-muted-foreground/70"}`}
				>
					{voice.name}
				</span>
			)}
			<span className="truncate">{where}</span>
		</p>
	);
}

/** Something that happened to the person's words, in the line's place. */
function Note({ children }: { children: ReactNode }) {
	return (
		<p className="mr-auto min-w-0 animate-[arrive_0.3s_ease-out] truncate text-muted-foreground">
			{children}
		</p>
	);
}

function Action({
	label,
	onClick,
	children,
}: {
	label: string;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			title={label}
			className="flex h-11 shrink-0 items-center gap-2 rounded-full px-4 text-foreground/80 transition hover:bg-white/10 hover:text-foreground sm:h-10 [&_svg]:size-4"
			onClick={onClick}
		>
			{children}
		</button>
	);
}

function SendButton({ voice }: { voice: Voice }) {
	return (
		<button
			type="button"
			title="Send it to your agent (Enter)"
			className="flex h-11 shrink-0 items-center gap-2 rounded-full bg-you px-5 font-medium text-black shadow-[0_0_24px_-4px_var(--you)] transition hover:brightness-110 sm:h-10"
			onClick={() => voice.send()}
		>
			Send
			<CornerDownLeft className="size-4 opacity-60" />
		</button>
	);
}

/** A name in the session as the person reads it: without the person's own
 * prefix, which every agent they invite carries. */
function label(name: string): string {
	const slash = name.indexOf("/");
	return slash < 0 ? name : name.slice(slash + 1);
}

/** Who else is in the session, each lit while it listens: an agent that is
 * not receiving is busy on a turn, or gone without leaving, which the
 * presence can't tell apart. Speech engines show as such. Agents also show
 * where the person's last message is: not read yet, or worked on. */
function People({
	people,
	progress,
}: {
	people: Present[];
	progress: Progress;
}) {
	return (
		<ul className="flex min-w-0 flex-1 items-center gap-4 overflow-hidden">
			{people.length === 0 && (
				<li className="text-sm text-muted-foreground">Only you</li>
			)}
			{people.map((person) => (
				<li
					key={person.name}
					title={`${person.name}${person.engine ? ", the speech engine" : ""}: ${
						person.receiving
							? "here, listening"
							: `busy${person.since ? ` since ${new Date(person.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}`
					}`}
					className="flex min-w-0 animate-[arrive_0.4s_ease-out] items-center gap-2 text-sm text-foreground/85"
				>
					{person.engine ? (
						<Cpu
							className={`size-3.5 shrink-0 ${person.receiving ? "text-agent" : "text-muted-foreground"}`}
						/>
					) : (
						<span
							aria-hidden
							className={`size-2 shrink-0 rounded-full transition ${person.receiving ? "bg-agent shadow-[0_0_8px_var(--agent)]" : "border border-agent/70"}`}
						/>
					)}
					<span className="truncate">
						{person.engine ? (
							<span className="text-muted-foreground">engine</span>
						) : (
							label(person.name)
						)}
					</span>
					{!person.engine && progress && (
						<span
							className={`shrink-0 text-xs ${progress === "working" ? "animate-[breathe_2.4s_ease-in-out_infinite] text-agent" : "text-muted-foreground"}`}
						>
							{progress === "working" ? "working" : "not read yet"}
						</span>
					)}
				</li>
			))}
		</ul>
	);
}

/** Leaving the session, which then starts a new one: a second press within
 * a few seconds confirms, since the agent can't follow into the new one. */
function Leave({ leave }: { leave: () => void }) {
	const [sure, setSure] = useState(false);
	useEffect(() => {
		if (!sure) return;
		const timer = setTimeout(() => setSure(false), 4000);
		return () => clearTimeout(timer);
	}, [sure]);
	return (
		<button
			type="button"
			title="Leave the session: once everyone has left, it is deleted"
			className={`flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm transition [&_svg]:size-4 ${sure ? "bg-destructive/15 text-destructive" : "text-muted-foreground hover:bg-white/10 hover:text-foreground"}`}
			onClick={() => (sure ? leave() : setSure(true))}
		>
			<LogOut />
			{sure ? "Leave for good?" : "Leave"}
		</button>
	);
}

/** The bar: one piece, listening on the left and speaking on the right, split
 * by a fine line. Each control keeps its place and its meaning in every state. */
function Bar({ voice, state }: { voice: Voice; state: VoiceState }) {
	const reading = state.reading !== null;
	return (
		<div className="flex w-full shrink-0 items-center justify-between rounded-full bg-black/35 p-1">
			<Half side="left" on={state.listener} color="--you">
				<Switch
					label={state.listener ? "Stop listening (Space)" : "Listen (Space)"}
					on={state.listener}
					busy={state.switching === "listener"}
					color="--you"
					level="--you-level"
					onClick={() => void voice.setListener(!state.listener)}
				>
					{state.listener ? <Mic /> : <MicOff />}
				</Switch>
				<AutoSend voice={voice} state={state} />
				<Small
					label="Copy your last transcript"
					disabled={!state.last}
					onClick={() => voice.copyLast()}
					done={<Check />}
				>
					<Copy />
				</Small>
			</Half>
			<span
				aria-hidden
				className="mx-0.5 h-7 w-px shrink-0 bg-white/10 sm:mx-1"
			/>
			<Half side="right" on={state.speaker} color="--agent">
				<Small
					label="Read the last message again"
					disabled={!state.message}
					onClick={() => voice.replay()}
				>
					<RotateCcw />
				</Small>
				<Small
					label={state.held ? "Resume" : "Pause"}
					disabled={!reading}
					onClick={() => voice.hold(!state.held)}
				>
					{state.held ? <Play /> : <Pause />}
				</Small>
				<Small label="Skip" disabled={!reading} onClick={() => voice.skip()}>
					<SkipForward />
				</Small>
				<Switch
					label={state.speaker ? "Stop reading aloud" : "Read aloud"}
					on={state.speaker}
					busy={state.switching === "speaker"}
					color="--agent"
					level="--agent-level"
					onClick={() => void voice.setSpeaker(!state.speaker)}
				>
					{state.speaker ? <Volume2 /> : <VolumeX />}
				</Switch>
			</Half>
		</div>
	);
}

/** A half of the bar, faintly tinted by its voice while on. */
function Half(props: {
	side: "left" | "right";
	on: boolean;
	color: string;
	children: ReactNode;
}) {
	const left = props.side === "left";
	return (
		<div
			className={`flex shrink-0 items-center gap-0.5 rounded-full transition-colors duration-300 sm:gap-1 ${left ? "pr-1" : "pl-1"}`}
			style={{
				background: props.on
					? `linear-gradient(to ${left ? "right" : "left"}, color-mix(in oklch, var(${props.color}) 12%, transparent), transparent)`
					: undefined,
			}}
		>
			{props.children}
		</div>
	);
}

/** Turning listening or speaking on and off: lit quietly in its voice's
 * colour while on, and glowing only as loud as it sounds. */
function Switch(props: {
	label: string;
	on: boolean;
	busy: boolean;
	color: string;
	level: string;
	onClick: () => void;
	children: ReactNode;
}) {
	const tint = (share: number) =>
		`color-mix(in oklch, var(${props.color}) ${share}%, transparent)`;
	return (
		<button
			type="button"
			title={props.label}
			aria-label={props.label}
			aria-pressed={props.on}
			disabled={props.busy}
			onClick={props.onClick}
			className={`grid size-12 shrink-0 place-items-center rounded-full transition-colors duration-150 [&_svg]:size-5 ${props.on ? "" : "bg-white/[0.07] text-foreground/60 hover:bg-white/15 hover:text-foreground"} ${props.busy ? "animate-pulse" : ""}`}
			style={
				props.on
					? {
							color: `color-mix(in oklch, var(${props.color}) 80%, white)`,
							background: tint(22),
							boxShadow: `inset 0 0 0 1px ${tint(55)}, 0 0 0 calc(var(${props.level}, 0) * 8px) ${tint(30)}, 0 0 calc(var(${props.level}, 0) * 40px) ${tint(60)}`,
						}
					: undefined
			}
		>
			{props.children}
		</button>
	);
}

/** Whether a turn goes out by itself as the person pauses: a setting of
 * listening, so it looks like one, a labelled switch rather than a button
 * that acts. Off, the words wait in the draft until the person sends them. */
function AutoSend({ voice, state }: { voice: Voice; state: VoiceState }) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={state.autoEnd}
			title={
				state.autoEnd
					? "Auto-send is on: your words go to your agent as you pause."
					: "Auto-send is off: your words wait until you send them."
			}
			className="flex h-11 shrink-0 flex-col items-center justify-center gap-1 rounded-full px-2 text-[10px] leading-none text-muted-foreground transition hover:bg-white/10 hover:text-foreground sm:h-9 sm:flex-row sm:gap-2 sm:px-3 sm:text-xs"
			onClick={() => voice.setAutoEnd(!state.autoEnd)}
		>
			<span>auto-send</span>
			<span
				aria-hidden
				className={`relative h-4 w-7 shrink-0 rounded-full transition-colors duration-300 ${state.autoEnd ? (state.listener ? "bg-you/80" : "bg-you/35") : "bg-white/15"}`}
			>
				<span
					className="absolute top-0.5 left-0.5 size-3 rounded-full bg-white shadow transition-transform duration-300 ease-out"
					style={{ transform: state.autoEnd ? "translateX(12px)" : "none" }}
				/>
			</span>
		</button>
	);
}

function Small(props: {
	label: string;
	disabled?: boolean;
	onClick: () => unknown;
	done?: ReactNode;
	children: ReactNode;
}) {
	const [done, setDone] = useState(false);
	useEffect(() => {
		if (!done) return;
		const timer = setTimeout(() => setDone(false), 1200);
		return () => clearTimeout(timer);
	}, [done]);
	return (
		<button
			type="button"
			title={props.label}
			aria-label={props.label}
			disabled={props.disabled}
			onClick={() =>
				void Promise.resolve(props.onClick()).then(
					() => props.done && setDone(true),
				)
			}
			className="grid size-11 shrink-0 place-items-center rounded-full text-foreground/80 transition hover:bg-white/10 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent sm:size-9 [&_svg]:size-[18px]"
		>
			{done ? props.done : props.children}
		</button>
	);
}

/** What is set once and then left: where speech runs, its voice and
 * languages, the sounds, the session's link, and debugging. */
function Settings(props: {
	open: boolean;
	close: () => void;
	voice: Voice;
	state: VoiceState;
	link?: string | undefined;
	changeKey?: (() => void) | undefined;
}) {
	const { voice, state } = props;
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const element = dialog.current;
		if (!element) return;
		if (props.open && !element.open) element.showModal();
		if (!props.open && element.open) element.close();
	}, [props.open]);
	const local = state.tier === "local";
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes it, natively
		<dialog
			ref={dialog}
			aria-label="Settings"
			onClose={props.close}
			// A click on the backdrop lands on the dialog itself.
			onClick={(event) => event.target === dialog.current && props.close()}
			className="m-auto w-[min(28rem,calc(100vw-1.5rem))] rounded-3xl border border-white/10 bg-neutral-900/90 p-0 text-foreground shadow-2xl shadow-black backdrop-blur-2xl backdrop:bg-black/50 backdrop:backdrop-blur-sm max-sm:mb-3"
		>
			<div className="flex flex-col gap-1 p-2">
				<div className="flex items-center justify-between py-1 pr-1 pl-4">
					<h2 className="text-base font-medium">Settings</h2>
					<button
						type="button"
						aria-label="Close"
						className="grid size-9 place-items-center rounded-full text-muted-foreground outline-none transition hover:bg-white/10 focus-visible:bg-white/10 hover:text-foreground [&_svg]:size-4"
						onClick={props.close}
					>
						<X />
					</button>
				</div>
				<Row
					title="Speech models"
					detail={
						local
							? state.engine
								? "On your agent's machine, through its engine."
								: "On your agent's machine. Waiting for its engine."
							: "On ElevenLabs, with your key."
					}
				>
					<Segmented
						label="Where speech models run"
						options={[
							["local", "Local"],
							["elevenlabs", "ElevenLabs"],
						]}
						value={state.tier}
						choose={(tier) => void voice.setTier(tier as VoiceState["tier"])}
					/>
				</Row>
				{local && state.engineVoices.length > 1 && (
					<Row title="Voice" detail="The voice your agent speaks with.">
						<EngineVoice voice={voice} state={state} />
					</Row>
				)}
				{!local && (
					<Row
						title="Languages"
						detail="The ones you speak, the most likely first. Empty is automatic."
					>
						<Languages voice={voice} state={state} />
					</Row>
				)}
				{!local && props.changeKey && (
					<Row title="ElevenLabs key" detail="Kept in this browser.">
						<button
							type="button"
							className="h-8 rounded-full bg-white/10 px-3 text-sm transition hover:bg-white/15"
							onClick={() => {
								props.close();
								props.changeKey?.();
							}}
						>
							Change
						</button>
					</Row>
				)}
				<Row
					title="Sounds"
					detail="Short cues for what happens, such as your message going out."
				>
					<Toggle
						label="Sounds"
						on={state.sounds}
						flip={() => voice.setSounds(!state.sounds)}
					/>
				</Row>
				{props.link && (
					<Row
						title="Session link"
						detail="Keep it secret: whoever holds it can talk to your agent."
					>
						<CopyLink link={props.link} />
					</Row>
				)}
				<p className="mt-2 border-t border-white/10 px-4 pt-4 text-xs tracking-widest text-muted-foreground uppercase">
					Debugging
				</p>
				<Row
					title="Download trace"
					detail="What voice did and the audio it heard, the last 5 minutes, as one file for whoever develops voice."
				>
					<DownloadTrace voice={voice} />
				</Row>
				<Row
					title="Share trace"
					detail="Sends the same into the session with each message, for your agent to improve voice."
				>
					<Toggle
						label="Share trace"
						on={state.sharing}
						flip={() => voice.share(!state.sharing)}
					/>
				</Row>
			</div>
		</dialog>
	);
}

/** Copies the page's link, which joins this session as the person. */
function CopyLink({ link }: { link: string }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [copied]);
	return (
		<button
			type="button"
			className="flex h-8 items-center gap-1.5 rounded-full bg-white/10 px-3 text-sm transition hover:bg-white/15"
			onClick={() =>
				void navigator.clipboard
					.writeText(
						new URL(`#${new URLSearchParams({ session: link })}`, location.href)
							.href,
					)
					.then(() => setCopied(true))
			}
		>
			{copied ? <Check className="size-4" /> : <Copy className="size-4" />}
			{copied ? "Copied" : "Copy"}
		</button>
	);
}

/** Saves the trace as a file, through the browser's own download. */
function DownloadTrace({ voice }: { voice: Voice }) {
	const [busy, setBusy] = useState(false);
	return (
		<button
			type="button"
			disabled={busy}
			className="flex h-8 items-center gap-1.5 rounded-full bg-white/10 px-3 text-sm transition hover:bg-white/15 disabled:opacity-50"
			onClick={async () => {
				setBusy(true);
				try {
					const { name, blob } = await voice.download();
					const link = document.createElement("a");
					link.href = URL.createObjectURL(blob);
					link.download = name;
					link.click();
					setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
				} finally {
					setBusy(false);
				}
			}}
		>
			<Download className="size-4" />
			Download
		</button>
	);
}

function Row({
	title,
	detail,
	children,
}: {
	title: string;
	detail: string;
	children: ReactNode;
}) {
	return (
		<div className="flex items-center gap-4 rounded-2xl px-4 py-3">
			<div className="min-w-0 flex-1">
				<p className="text-sm">{title}</p>
				<p className="text-xs text-pretty text-muted-foreground">{detail}</p>
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	);
}

function Toggle({
	label,
	on,
	flip,
}: {
	label: string;
	on: boolean;
	flip: () => void;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={on}
			aria-label={label}
			className={`relative h-6 w-10 rounded-full transition-colors duration-300 ${on ? "bg-foreground" : "bg-white/15"}`}
			onClick={flip}
		>
			<span
				className={`absolute top-0.5 left-0.5 size-5 rounded-full shadow transition-transform duration-300 ease-out ${on ? "bg-background" : "bg-white/80"}`}
				style={{ transform: on ? "translateX(16px)" : "none" }}
			/>
		</button>
	);
}

function Segmented({
	label,
	options,
	value,
	choose,
}: {
	label: string;
	options: [string, string][];
	value: string;
	choose: (value: string) => void;
}) {
	return (
		<fieldset
			aria-label={label}
			className="m-0 flex min-w-0 rounded-full border-0 bg-black/40 p-0.5 text-xs"
		>
			{options.map(([id, name]) => (
				<button
					key={id}
					type="button"
					aria-pressed={value === id}
					className={`h-7 rounded-full px-3 transition-colors ${value === id ? "bg-white/15 text-foreground" : "text-muted-foreground hover:text-foreground"}`}
					onClick={() => choose(id)}
				>
					{name}
				</button>
			))}
		</fieldset>
	);
}

/** Kokoro's kinds of voice, by the first two letters of a voice's name. */
const KINDS: Record<string, string> = {
	af: "American, female",
	am: "American, male",
	bf: "British, female",
	bm: "British, male",
};

/** The engine's voice the agent speaks with, chosen from those it offers,
 * grouped by their kind where the name shows one, as Kokoro's do. */
function EngineVoice({ voice, state }: { voice: Voice; state: VoiceState }) {
	const name = (v: string) => (KINDS[v.slice(0, 2)] ? v.slice(3) : v);
	const groups = new Map<string, string[]>();
	for (const v of [...state.engineVoices].sort()) {
		const kind = KINDS[v.slice(0, 2)] ?? "Other";
		groups.set(kind, [...(groups.get(kind) ?? []), v]);
	}
	return (
		<select
			aria-label="The voice your agent speaks with"
			className="h-8 cursor-pointer rounded-full bg-white/10 px-3 text-sm capitalize outline-none transition hover:bg-white/15"
			value={state.engineVoice ?? ""}
			onChange={(event) => voice.setEngineVoice(event.target.value)}
		>
			{[...groups].map(([kind, voices]) => (
				<optgroup key={kind} label={kind}>
					{voices.map((v) => (
						<option key={v} value={v}>
							{name(v)}
						</option>
					))}
				</optgroup>
			))}
		</select>
	);
}

const names = new Intl.DisplayNames(["en"], { type: "language" });

/** The languages the person speaks, for transcription, typed as codes such
 * as `en, de`, the most likely first; none is automatic. */
function Languages({ voice, state }: { voice: Voice; state: VoiceState }) {
	const [editing, setEditing] = useState(state.languages.join(", "));
	const save = () => {
		const codes = editing
			.toLowerCase()
			.split(/[\s,]+/)
			.filter((code) => /^[a-z]{2,3}$/.test(code) && names.of(code) !== code);
		void voice.setLanguages([...new Set(codes)]);
		setEditing(codes.join(", "));
	};
	return (
		<input
			aria-label="The languages you speak, as codes such as en, de"
			placeholder="auto"
			className="h-8 w-24 rounded-full bg-white/10 px-3 text-sm outline-none placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring/50"
			value={editing}
			onChange={(event) => setEditing(event.target.value)}
			onBlur={save}
			onKeyDown={(event) => {
				if (event.key === "Enter") save();
			}}
		/>
	);
}

/** Space turns listening on and off, Enter sends the words, Escape drops
 * them. Not while typing in the draft, except Escape, nor in a field, nor
 * while the settings are open. */
function useShortcuts(voice: Voice, state: VoiceState, settings: boolean) {
	const words = Boolean(state.draft || state.hearing);
	useEffect(() => {
		if (settings) return;
		const key = (event: KeyboardEvent) => {
			if (event.target instanceof HTMLInputElement) return;
			const typing = event.target instanceof HTMLTextAreaElement;
			if (event.key === "Escape") voice.clear();
			else if (typing || event.repeat) return;
			else if (event.key === " ") void voice.setListener(!state.listener);
			else if (event.key === "Enter" && words) voice.send();
			else return;
			event.preventDefault();
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [voice, state.listener, words, settings]);
}
