// Voice as a playback bar, as a media player's: one fixed piece of two halves,
// listening on the left and speaking on the right, mirrored. Each half has one
// switch at its end and the controls that act on what it holds: the person's
// words not yet sent, the agent's message being read. A switch that is on is
// lit quietly, and brightly only as loud as its voice really sounds. Beside
// listening, auto-send only decides whether a turn goes out by itself as the
// person pauses: the microphone always just listens or stops.
//
// The page is mostly open in the background, so it shows one thing loud: who
// has the floor, as a word and as light, the person's warm and the agent's
// cool. Once the person speaks, their words take its place, large, as one
// text, with what happens to them below: the agent's words belong to its
// harness. What is set once, such as the tier, waits behind the settings. The
// system's media controls work it too, so that it needs no looking at.
import {
	Check,
	Copy,
	CornerDownLeft,
	Download,
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
import { showMedia } from "./media.ts";
import type { Voice, VoiceState } from "./voice.ts";

export function VoiceBar({
	voice,
	leave,
	changeKey,
}: {
	voice: Voice;
	/** Leaves the session, from the settings. */
	leave?: (() => void) | undefined;
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
			<header className="flex w-full shrink-0 items-center gap-3">
				<p className="flex-1 truncate text-xs tracking-[0.2em] text-muted-foreground/70 uppercase">
					{mode(state)}
				</p>
				<Who state={state} />
				<div className="flex flex-1 justify-end">
					<button
						type="button"
						title="Settings"
						aria-label="Settings"
						aria-haspopup="dialog"
						className="grid size-11 place-items-center rounded-full text-muted-foreground transition hover:bg-white/10 hover:text-foreground [&_svg]:size-[18px]"
						onClick={() => setSettings(true)}
					>
						<SlidersHorizontal />
					</button>
				</div>
			</header>
			<Stage voice={voice} state={state} />
			{state.error && (
				<p className="max-w-xl text-center text-sm text-pretty text-destructive">
					{state.error}
				</p>
			)}
			<Missed voice={voice} state={state} />
			<Bar voice={voice} state={state} />
			<Settings
				open={settings}
				close={() => setSettings(false)}
				voice={voice}
				state={state}
				leave={leave}
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
	breathing?: boolean;
} {
	if (state.hearing)
		return {
			word: `Hearing ${who(state)?.name ?? "you"}`,
			tone: "you",
			hint: "",
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
	if (state.progress === "working")
		return {
			word: "Working",
			tone: "agent",
			hint: "Your agent is on your message.",
			breathing: true,
		};
	if (state.progress === "sent")
		return { word: "Sent", tone: "agent", hint: "Waiting for your agent." };
	if (state.listener)
		return {
			word: "Listening",
			tone: "you",
			hint: state.autoEnd
				? "Speak, and your words go to your agent as you pause."
				: "Speak, and send your words when you're done.",
		};
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

/** The voice heard now, as a name lit by the person's level, which fades
 * out between turns. Only there once the agent named any voice, so that one
 * person alone sees nothing of it. */
function Who({ state }: { state: VoiceState }) {
	const now = who(state);
	// The last voice heard stays as it fades out.
	const last = useRef(now);
	if (now) last.current = now;
	const shown = last.current;
	if (Object.keys(state.names).length === 0) return null;
	return (
		<p
			aria-live="polite"
			className={`flex h-7 shrink-0 items-center gap-2.5 rounded-full bg-black/30 px-3.5 text-xs tracking-widest uppercase transition-opacity duration-500 ${now ? "opacity-100" : "opacity-0"}`}
		>
			<span
				className={`size-2 rounded-full ${shown?.named ? "bg-you" : "bg-muted-foreground"}`}
				style={{
					boxShadow: `0 0 calc(4px + var(--you-level, 0) * 16px) ${shown?.named ? "var(--you)" : "transparent"}`,
					transform: "scale(calc(1 + var(--you-level, 0) * 0.8))",
				}}
			/>
			<span
				className={
					shown?.named ? "text-foreground" : "text-muted-foreground/70"
				}
			>
				{shown?.name}
			</span>
		</p>
	);
}

/** The levels of both voices, eased, as the CSS variables `--you-level` and
 * `--agent-level` on `root`. */
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
 * has the floor, with the words last deleted to bring back. */
function Stage({ voice, state }: { voice: Voice; state: VoiceState }) {
	if (state.draft || state.hearing)
		return (
			<Words voice={voice} state={state}>
				<Actions>
					<Status state={state} />
					<Action
						label="Delete it (Escape): Undo brings it back"
						onClick={() => voice.clear()}
					>
						<Trash2 />
						Delete
					</Action>
					<SendButton voice={voice} />
				</Actions>
			</Words>
		);
	return (
		<Floor state={state}>
			{state.dropped && <Dropped voice={voice} text={state.dropped} />}
		</Floor>
	);
}

/** Who has the floor, large enough to read from across the room. */
function Floor({
	state,
	children,
}: {
	state: VoiceState;
	children?: ReactNode;
}) {
	const { word, tone, hint, breathing } = floor(state);
	const color =
		tone === "none"
			? "var(--muted-foreground)"
			: `var(--${tone === "you" ? "you" : "agent"})`;
	return (
		<div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-4 text-center">
			{children}
			<p
				aria-live="polite"
				className={`text-5xl font-extralight tracking-tight transition-colors duration-500 sm:text-6xl ${breathing ? "animate-[breathe_2.4s_ease-in-out_infinite]" : ""}`}
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
			<p className="max-w-sm text-base text-balance text-muted-foreground/70">
				{hint}
			</p>
		</div>
	);
}

/** The person's words, large, as one text: what is still being heard follows
 * the draft, quieter, and the draft can be edited once nothing more is being
 * heard into it. What acts on them is underneath. */
function Words({
	voice,
	state,
	children,
}: {
	voice: Voice;
	state: VoiceState;
	children: ReactNode;
}) {
	return (
		<div className="flex min-h-0 w-full max-w-2xl flex-1 flex-col gap-3 pt-4 text-2xl leading-snug font-light sm:text-3xl">
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
			{children}
		</div>
	);
}

/** What happens to the words: whether more are heard into them, and whether
 * they go out by themselves. */
function Status({ state }: { state: VoiceState }) {
	const text = !state.listener
		? state.hearing
			? "Finishing your words…"
			: "Microphone off"
		: state.autoEnd
			? "Sends as you pause"
			: "Listening";
	return (
		<p className="mr-auto flex min-w-0 items-center gap-2 text-muted-foreground">
			<span
				aria-hidden
				className={`size-2 shrink-0 rounded-full ${state.listener ? "bg-you" : "bg-white/25"}`}
				style={
					state.listener
						? {
								boxShadow:
									"0 0 calc(2px + var(--you-level, 0) * 10px) var(--you)",
							}
						: undefined
				}
			/>
			<span className="truncate">{text}</span>
		</p>
	);
}

function Actions({ children }: { children: ReactNode }) {
	return (
		<div className="flex shrink-0 items-center justify-end gap-1 text-sm font-normal sm:gap-2">
			{children}
		</div>
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

/** The words last deleted, with a way back. */
function Dropped({ voice, text }: { voice: Voice; text: string }) {
	return (
		<div className="mb-6 flex max-w-md flex-col items-center gap-2 text-sm">
			<p className="flex items-center gap-1.5 text-xs tracking-widest text-muted-foreground uppercase">
				<Trash2 className="size-3.5" />
				Deleted
			</p>
			<p className="line-clamp-3 text-base text-muted-foreground/80 line-through decoration-muted-foreground/40">
				{text}
			</p>
			<button
				type="button"
				title="Bring your words back"
				className="flex h-11 items-center gap-1.5 rounded-full px-4 text-foreground/80 transition hover:bg-white/10 hover:text-foreground sm:h-9"
				onClick={() => voice.undo()}
			>
				<Undo2 className="size-4" />
				Undo
			</button>
		</div>
	);
}

/** Words heard while the agent spoke that didn't count, to send if they
 * were the person's. */
function Missed({ voice, state }: { voice: Voice; state: VoiceState }) {
	if (!state.missed) return null;
	const why = {
		echo: "sounded like your agent",
		quiet: "too quiet",
		backchannel: "said while your agent spoke",
	}[state.missed.why];
	return (
		<p className="flex max-w-xl items-center gap-2 rounded-full bg-white/[0.04] py-1 pr-1 pl-4 text-sm text-muted-foreground">
			<span className="truncate">
				Not sent, {why}: “{state.missed.text}”
			</span>
			<button
				type="button"
				title="Send it to your agent, as yours"
				className="h-11 shrink-0 rounded-full px-4 font-medium text-foreground transition hover:bg-white/10 sm:h-8"
				onClick={() => voice.sendMissed()}
			>
				Send
			</button>
		</p>
	);
}

/** The bar: one piece, listening on the left and speaking on the right, split
 * by a fine line. Each control keeps its place and its meaning in every state. */
function Bar({ voice, state }: { voice: Voice; state: VoiceState }) {
	const reading = state.reading !== null;
	return (
		<div className="flex max-w-full shrink-0 items-center rounded-full border border-white/10 bg-neutral-950/50 p-1 shadow-2xl shadow-black/60 backdrop-blur-xl sm:p-1.5">
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
					working={state.progress === "working"}
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
	/** Whether to breathe, as the agent's while it works. */
	working?: boolean;
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
			className={`grid size-12 shrink-0 place-items-center rounded-full transition-colors duration-150 [&_svg]:size-5 ${props.on ? "" : "bg-white/[0.07] text-foreground/60 hover:bg-white/15 hover:text-foreground"} ${props.busy ? "animate-pulse" : ""} ${props.working ? "animate-[working_2.4s_ease-in-out_infinite]" : ""}`}
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
 * languages, the sounds, sharing the trace, and leaving. */
function Settings(props: {
	open: boolean;
	close: () => void;
	voice: Voice;
	state: VoiceState;
	leave?: (() => void) | undefined;
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
				{props.leave && (
					<div className="mt-2 flex items-center gap-3 border-t border-white/10 px-4 pt-4 pb-2">
						<p className="flex-1 text-sm text-pretty text-muted-foreground">
							Keep this page's link secret: whoever holds it can talk to your
							agent.
						</p>
						<button
							type="button"
							title="Leave the session: once everyone has left, it is deleted"
							className="h-9 shrink-0 rounded-full border border-white/15 px-4 text-sm transition hover:border-destructive/60 hover:text-destructive"
							onClick={() => {
								props.close();
								props.leave?.();
							}}
						>
							Leave
						</button>
					</div>
				)}
			</div>
		</dialog>
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
