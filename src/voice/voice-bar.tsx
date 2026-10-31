// Voice as a playback bar of two parts, as a media player's: listening on the
// left, speaking on the right, the same parts mirrored, each a pill that joins
// the other into one as both are on, a conversation. Each part has one switch,
// glowing as loud as its voice, and the controls that act on what it holds:
// the person's words not yet sent, the agent's message being read.
//
// The page is mostly open in the background, so it shows one thing loud: who
// has the floor, as a word and as light, the person's warm and the agent's
// cool. Once the person speaks, their words take its place, large: the
// agent's words belong to its harness. What is set once, such as the tier,
// waits behind the settings. The system's media controls work it too, so that
// it needs no looking at. With turns ended by hand the left switch records:
// one message at a time, sent or deleted from under the words.
import {
	Check,
	Copy,
	CornerDownLeft,
	Mic,
	MicOff,
	Pause,
	Play,
	RotateCcw,
	SkipForward,
	SlidersHorizontal,
	Square,
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
			<Aura working={state.progress === "working" && state.reading === null} />
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
						className="grid size-10 place-items-center rounded-full text-muted-foreground transition hover:bg-white/10 hover:text-foreground [&_svg]:size-[18px]"
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

function mode({ listener, speaker, autoEnd }: VoiceState): string {
	if (!autoEnd) return speaker ? "Voice messages" : "Dictation";
	if (listener && speaker) return "Conversation";
	if (listener) return "Transcription";
	if (speaker) return "Read aloud";
	return "Off";
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
	if (!state.autoEnd && state.recording)
		return { word: "Recording", tone: "you", hint: "Say your message." };
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
					hint: "Speak to cut in: your agent pauses for you.",
				};
	if (state.progress === "working")
		return {
			word: "Thinking",
			tone: "agent",
			hint: "Your agent is working on your message.",
			breathing: true,
		};
	if (state.progress === "sent")
		return { word: "Sent", tone: "agent", hint: "Waiting for your agent." };
	if (state.listener && state.autoEnd)
		return {
			word: "Listening",
			tone: "you",
			hint: "Speak, and your words go to your agent as you pause.",
		};
	if (!state.autoEnd)
		return {
			word: "Ready",
			tone: "none",
			hint: "Tap the microphone to record a message.",
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

/** Both voices as light behind the page, each brighter as it is louder, the
 * agent's breathing while it works. */
function Aura({ working }: { working: boolean }) {
	const glow = (color: string, level: string, at: string): CSSProperties => ({
		left: at,
		background: `radial-gradient(closest-side, color-mix(in oklch, var(${color}) 45%, transparent), transparent)`,
		opacity: `calc(0.25 + var(${level}, 0) * 0.75)`,
		transform: `translate(-50%, 50%) scale(calc(0.85 + var(${level}, 0) * 0.35))`,
	});
	return (
		<div
			aria-hidden
			className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
		>
			<div
				className="absolute bottom-0 h-[70vh] w-[90vmax]"
				style={glow("--you", "--you-level", "25%")}
			/>
			<div
				className={`absolute bottom-0 h-[70vh] w-[90vmax] ${working ? "animate-[breathe_2.4s_ease-in-out_infinite]" : ""}`}
				style={glow("--agent", "--agent-level", "75%")}
			/>
		</div>
	);
}

/** The middle of the page: the person's words once there are any, else who
 * has the floor. */
function Stage({ voice, state }: { voice: Voice; state: VoiceState }) {
	if (!state.autoEnd) return <Recorder voice={voice} state={state} />;
	if (state.draft || state.hearing) {
		return (
			<Words voice={voice} state={state} editable>
				<Actions>
					<Action
						label="Drop it (Escape): it can still be copied"
						onClick={() => voice.clear()}
					>
						<X />
						Drop
					</Action>
					<SendButton voice={voice} />
				</Actions>
			</Words>
		);
	}
	return <Floor state={state} />;
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

/** The person's words, large, editable once nothing more is being heard
 * into them, with what acts on them underneath. */
function Words({
	voice,
	state,
	editable,
	children,
}: {
	voice: Voice;
	state: VoiceState;
	editable: boolean;
	children: ReactNode;
}) {
	return (
		<div className="flex min-h-0 w-full flex-1 flex-col gap-3 pt-4 text-2xl leading-snug font-light sm:text-3xl">
			{editable ? (
				<>
					<textarea
						aria-label="What you said, to edit before sending"
						className="min-h-0 flex-1 resize-none bg-transparent text-balance outline-none"
						value={state.draft}
						onChange={(event) => voice.setDraft(event.target.value)}
					/>
					{state.hearing && (
						<p className="text-muted-foreground">{state.hearing}</p>
					)}
				</>
			) : (
				// Editing waits until the recording stops, so the words heard so
				// far read on as one text.
				<p className="min-h-0 flex-1 overflow-y-auto">
					{state.draft}{" "}
					<span className="text-muted-foreground">{state.hearing}</span>
				</p>
			)}
			{children}
		</div>
	);
}

function Actions({ children }: { children: ReactNode }) {
	return (
		<div className="flex shrink-0 items-center justify-end gap-2 text-sm font-normal">
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
			className="flex h-10 items-center gap-2 rounded-full px-4 text-foreground/80 transition hover:bg-white/10 hover:text-foreground [&_svg]:size-4"
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
			className="flex h-10 items-center gap-2 rounded-full bg-you px-5 font-medium text-black shadow-[0_0_24px_-4px_var(--you)] transition hover:brightness-110"
			onClick={() => voice.send()}
		>
			Send
			<CornerDownLeft className="size-4 opacity-60" />
		</button>
	);
}

/** Turns ended by hand: a message recorded, then sent or deleted. */
function Recorder({ voice, state }: { voice: Voice; state: VoiceState }) {
	const words = Boolean(state.draft || state.hearing);
	if (!words)
		return (
			<Floor state={state}>
				{state.ended && !state.recording && (
					<Ended voice={voice} ended={state.ended} />
				)}
			</Floor>
		);
	return (
		<Words voice={voice} state={state} editable={!state.recording}>
			<Actions>
				<p className="mr-auto flex items-center gap-2 text-muted-foreground">
					{state.recording ? (
						<>
							<span className="size-2 animate-pulse rounded-full bg-red-500 shadow-[0_0_8px_var(--color-red-500)]" />
							Recording
						</>
					) : (
						"Tap the microphone to add more"
					)}
				</p>
				<Action
					label="Delete this message (Escape)"
					onClick={() => voice.clear()}
				>
					<Trash2 />
					Delete
				</Action>
				<SendButton voice={voice} />
			</Actions>
		</Words>
	);
}

/** The message last ended by hand: sent, or deleted, with a way back. */
function Ended({
	voice,
	ended,
}: {
	voice: Voice;
	ended: { text: string; sent: boolean };
}) {
	return (
		<div className="mb-6 flex max-w-md flex-col items-center gap-2 text-sm">
			<p className="flex items-center gap-1.5 text-xs tracking-widest text-muted-foreground uppercase">
				{ended.sent ? (
					<Check className="size-3.5" />
				) : (
					<Trash2 className="size-3.5" />
				)}
				{ended.sent ? "Sent" : "Deleted"}
			</p>
			<p
				className={`line-clamp-3 text-base text-muted-foreground/80 ${ended.sent ? "" : "line-through decoration-muted-foreground/40"}`}
			>
				{ended.text}
			</p>
			{!ended.sent && (
				<button
					type="button"
					title="Bring the message back"
					className="flex h-8 items-center gap-1.5 rounded-full px-3 text-foreground/80 transition hover:bg-white/10 hover:text-foreground"
					onClick={() => voice.undo()}
				>
					<Undo2 className="size-4" />
					Undo
				</button>
			)}
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
				className="shrink-0 rounded-full px-3 py-1 font-medium text-foreground transition hover:bg-white/10"
				onClick={() => voice.sendMissed()}
			>
				Send
			</button>
		</p>
	);
}

/** The two parts: listening and speaking, apart, or joined while both are
 * on. Each control keeps its place and its meaning in every state. */
function Bar({ voice, state }: { voice: Voice; state: VoiceState }) {
	const manual = !state.autoEnd;
	const listening = manual ? state.recording : state.listener;
	const joined = listening && state.speaker;
	const reading = state.reading !== null;
	return (
		<div
			className={`flex w-full max-w-xl shrink-0 justify-center transition-[gap] duration-500 ${joined ? "gap-0" : "gap-2 sm:gap-3"}`}
		>
			<Part side="left" on={listening} joined={joined} color="--you">
				{manual ? (
					<Switch
						label={state.recording ? "Stop recording" : "Record a message"}
						on={state.recording}
						busy={state.switching === "listener"}
						color="--you"
						level="--you-level"
						onClick={() => void voice.record(!state.recording)}
					>
						{state.recording ? <Square className="fill-current" /> : <Mic />}
					</Switch>
				) : (
					<Switch
						label={state.listener ? "Stop listening" : "Listen"}
						on={state.listener}
						busy={state.switching === "listener"}
						color="--you"
						level="--you-level"
						onClick={() => void voice.setListener(!state.listener)}
					>
						{state.listener ? <Mic /> : <MicOff />}
					</Switch>
				)}
				<AutoSend voice={voice} state={state} />
				<Small
					label="Copy your last transcript"
					disabled={!state.last}
					onClick={() => voice.copyLast()}
					done={<Check />}
				>
					<Copy />
				</Small>
			</Part>
			<Part side="right" on={state.speaker} joined={joined} color="--agent">
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
					label={state.speaker ? "Stop speaking" : "Speak"}
					on={state.speaker}
					busy={state.switching === "speaker"}
					color="--agent"
					level="--agent-level"
					working={state.progress === "working"}
					onClick={() => void voice.setSpeaker(!state.speaker)}
				>
					{state.speaker ? <Volume2 /> : <VolumeX />}
				</Switch>
			</Part>
		</div>
	);
}

/** A part of the bar, tinted by its voice while on, its inner edge squared
 * while joined to the other. */
function Part(props: {
	side: "left" | "right";
	on: boolean;
	joined: boolean;
	color: string;
	children: ReactNode;
}) {
	const inner = props.joined ? "6px" : "999px";
	const left = props.side === "left";
	return (
		<div
			className={`flex shrink-0 items-center gap-0.5 border p-1 sm:gap-1 sm:p-1.5 ${left ? "pr-1.5 sm:pr-2" : "pl-1.5 sm:pl-2"} shadow-2xl shadow-black/60 backdrop-blur-xl transition-all duration-500 ${props.on ? "bg-white/[0.08]" : "border-white/10 bg-white/[0.03]"}`}
			style={{
				borderRadius: left
					? `999px ${inner} ${inner} 999px`
					: `${inner} 999px 999px ${inner}`,
				...(props.on && {
					borderColor: `color-mix(in oklch, var(${props.color}) 30%, transparent)`,
				}),
				...(props.joined && left && { borderRightColor: "transparent" }),
			}}
		>
			{props.children}
		</div>
	);
}

/** Turning listening or speaking on and off: filled with its voice's colour
 * while on, and glowing as loud as it sounds. */
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
			className={`grid size-12 shrink-0 place-items-center rounded-full transition-colors duration-300 [&_svg]:size-5 ${props.on ? "text-black" : "bg-white/10 text-foreground/70 hover:bg-white/15 hover:text-foreground"} ${props.busy ? "animate-pulse" : ""} ${props.working ? "animate-[working_2.4s_ease-in-out_infinite]" : ""}`}
			style={
				props.on
					? {
							background: `var(${props.color})`,
							boxShadow: `0 0 0 calc(var(${props.level}, 0) * 10px) ${tint(35)}, 0 0 calc(12px + var(${props.level}, 0) * 36px) ${tint(55)}`,
						}
					: undefined
			}
		>
			{props.children}
		</button>
	);
}

/** Whether a turn ends by itself at a pause: a setting of listening, so it
 * looks like one, a labelled switch rather than a button that acts. Off, the
 * person records each message and sends it. */
function AutoSend({ voice, state }: { voice: Voice; state: VoiceState }) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={state.autoEnd}
			title={
				state.autoEnd
					? "Auto-send is on: your turn ends when you pause. Turn it off to record each message and send it yourself."
					: "Auto-send is off: record each message, then send it. Turn it on to have your turn end when you pause."
			}
			className="flex h-9 shrink-0 items-center gap-2 rounded-full px-2.5 text-xs text-muted-foreground transition hover:bg-white/10 hover:text-foreground sm:px-3"
			onClick={() => voice.setAutoEnd(!state.autoEnd)}
		>
			<span>auto-send</span>
			<span
				aria-hidden
				className={`relative h-4 w-7 shrink-0 rounded-full transition-colors duration-300 ${state.autoEnd ? "bg-you/80" : "bg-white/15"}`}
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
			className="grid size-9 shrink-0 place-items-center rounded-full text-foreground/80 transition hover:bg-white/10 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent [&_svg]:size-[18px]"
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
				<Row
					title="Share trace"
					detail="Sends your agent what voice does, with the audio it heard, so that it can improve voice."
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

/** Space turns listening, or recording, on and off, Enter sends what was said by hand,
 * Escape drops it. Not while typing in the draft, except Escape, nor in a
 * field, nor while the settings are open. */
function useShortcuts(voice: Voice, state: VoiceState, settings: boolean) {
	useEffect(() => {
		if (settings) return;
		const key = (event: KeyboardEvent) => {
			if (event.target instanceof HTMLInputElement) return;
			const typing = event.target instanceof HTMLTextAreaElement;
			if (event.key === "Escape") voice.clear();
			else if (typing || event.repeat) return;
			else if (event.key === " ")
				void (state.autoEnd
					? voice.setListener(!state.listener)
					: voice.record(!state.recording));
			else if (event.key === "Enter" && !state.autoEnd) voice.send();
			else return;
			event.preventDefault();
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [voice, state.listener, state.autoEnd, state.recording, settings]);
}
