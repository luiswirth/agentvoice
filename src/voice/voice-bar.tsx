// Voice as a playback bar: one floating pill whose left end is listening and
// right end speaking, mirrored, meeting in a track that shows both. Listen
// alone is transcription, Speak alone reading aloud, both a conversation.
// Above it, large, what is happening now. The system's media controls work
// it too, so that it needs no looking at.
import {
	Check,
	Copy,
	Mic,
	MicOff,
	Pause,
	Play,
	RotateCcw,
	SendHorizontal,
	SkipForward,
	Volume2,
	VolumeX,
	X,
} from "lucide-react";
import {
	type ReactNode,
	useEffect,
	useState,
	useSyncExternalStore,
} from "react";
import { showMedia } from "./media.ts";
import type { Voice, VoiceState } from "./voice.ts";

export function VoiceBar({ voice }: { voice: Voice }) {
	const state = useSyncExternalStore(voice.watch, () => voice.state);
	useShortcuts(voice, state);
	useEffect(() => {
		showMedia(now(state) || doing(state) || "voice", mode(state));
	}, [state]);
	return (
		<div className="flex min-h-0 flex-1 flex-col items-center gap-6">
			<Now voice={voice} state={state} />
			{state.error && <p className="text-sm text-destructive">{state.error}</p>}
			<p className="text-xs tracking-widest text-muted-foreground uppercase">
				{mode(state)}
				{doing(state) && ` · ${doing(state)}`}
			</p>
			<Bar voice={voice} state={state} />
		</div>
	);
}

function mode({ listener, speaker }: VoiceState): string {
	if (listener && speaker) return "Conversation";
	if (listener) return "Transcription";
	if (speaker) return "Read aloud";
	return "Off";
}

function doing(state: VoiceState): string {
	if (state.hearing) return "hearing you";
	if (state.reading !== null) return state.held ? "paused" : "speaking";
	if (state.draft) return "your draft";
	if (state.listener) return "listening";
	if (state.speaker) return "waiting";
	return "";
}

function now(state: VoiceState): string {
	const yours = [state.draft, state.hearing].filter(Boolean).join(" ");
	if (yours) return yours;
	if (state.speaker && state.message) return state.message;
	return "";
}

/** What is happening now, large: the person's words, or the agent's. */
function Now({ voice, state }: { voice: Voice; state: VoiceState }) {
	const base =
		"w-full min-h-0 flex-1 overflow-y-auto text-2xl leading-snug font-light text-balance";
	if ((state.draft || state.hearing) && !state.autoEnd) {
		return (
			<div className={`${base} flex flex-col`}>
				<textarea
					aria-label="What you said, to edit before sending"
					className="min-h-0 flex-1 resize-none bg-transparent outline-none"
					value={state.draft}
					onChange={(event) => voice.setDraft(event.target.value)}
				/>
				{state.hearing && (
					<p className="text-muted-foreground">{state.hearing}</p>
				)}
			</div>
		);
	}
	if (state.draft || state.hearing) {
		return (
			<p className={base}>
				{state.draft}{" "}
				<span className="text-muted-foreground">{state.hearing}</span>
			</p>
		);
	}
	if (state.speaker && state.message) {
		return (
			<p
				className={`${base} whitespace-pre-wrap ${state.reading === null ? "text-muted-foreground/60" : ""}`}
			>
				{state.message}
			</p>
		);
	}
	return (
		<p
			className={`${base} flex items-center justify-center text-center text-muted-foreground`}
		>
			{hint(state)}
		</p>
	);
}

function hint({ listener, speaker }: VoiceState): string {
	if (listener) return "Speak, and your words go to your agent.";
	if (speaker) return "Your agent's messages are read aloud as they arrive.";
	return "Your agent's ears on the left, its voice on the right.";
}

/** The pill: listening on the left, speaking on the right, mirrored. */
function Bar({ voice, state }: { voice: Voice; state: VoiceState }) {
	const said = Boolean(state.draft || state.hearing);
	const reading = state.reading !== null;
	return (
		<div className="flex w-full max-w-xl items-center gap-1 rounded-full border border-white/10 bg-white/[0.06] p-1.5 shadow-2xl shadow-black/60 backdrop-blur-xl">
			<Round
				label={state.listener ? "Stop listening" : "Listen"}
				on={state.listener}
				disabled={state.switching === "listener"}
				onClick={() => void voice.setListener(!state.listener)}
				glow={state.listener ? state.level : 0}
			>
				{state.listener ? <Mic /> : <MicOff />}
			</Round>
			<button
				type="button"
				title="Send after a pause, or by hand"
				className="rounded-full px-2 py-1 text-xs whitespace-nowrap text-muted-foreground hover:bg-white/10 hover:text-foreground"
				onClick={() => voice.setAutoEnd(!state.autoEnd)}
			>
				{state.autoEnd ? "auto" : "by hand"}
			</button>
			<Small
				label="Copy last transcript"
				disabled={!state.last}
				onClick={() => voice.copyLast()}
				done={<Check />}
			>
				<Copy />
			</Small>
			<div className="flex min-w-0 flex-1 items-center justify-center gap-1">
				{said && !state.autoEnd ? (
					<>
						<Small label="Drop" onClick={() => voice.clear()}>
							<X />
						</Small>
						<button
							type="button"
							className="flex h-9 items-center gap-1.5 rounded-full bg-foreground px-4 text-sm font-medium text-background"
							onClick={() => voice.send()}
						>
							<SendHorizontal className="size-4" />
							Send
						</button>
					</>
				) : (
					<Track state={state} />
				)}
			</div>
			<Small label="Read last message again" onClick={() => voice.replay()}>
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
			<Round
				label={state.speaker ? "Stop speaking" : "Speak"}
				on={state.speaker}
				onClick={() => void voice.setSpeaker(!state.speaker)}
				glow={reading && !state.held ? 0.6 : 0}
			>
				{state.speaker ? <Volume2 /> : <VolumeX />}
			</Round>
		</div>
	);
}

/** Where listening and speaking meet: the microphone's level grows from the
 * left, the voice's from the right. */
function Track({ state }: { state: VoiceState }) {
	const speaking = state.reading !== null && !state.held;
	return (
		<div className="flex h-9 w-full items-center gap-[3px] px-2">
			{Array.from({ length: 24 }, (_, i) => {
				const left = i < 12;
				const level = left
					? state.level * (1 - Math.abs(i - 6) / 8)
					: speaking
						? 0.5
						: 0;
				return (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed bars
						key={i}
						className={`flex-1 rounded-full transition-[height] duration-100 ${left ? "bg-foreground/70" : "bg-foreground/40"} ${!left && speaking ? "animate-pulse" : ""}`}
						style={{
							height: `${Math.max(3, Math.round(level * 28 * (left ? 1 : 0.5 + ((i * 7) % 5) / 8)))}px`,
						}}
					/>
				);
			})}
		</div>
	);
}

function Round(props: {
	label: string;
	on: boolean;
	disabled?: boolean;
	glow: number;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			title={props.label}
			aria-label={props.label}
			aria-pressed={props.on}
			disabled={props.disabled}
			onClick={props.onClick}
			className={`grid size-12 shrink-0 place-items-center rounded-full transition [&_svg]:size-5 ${props.on ? "bg-foreground text-background" : "bg-white/10 text-foreground hover:bg-white/15"}`}
			style={{
				boxShadow: props.glow
					? `0 0 0 ${2 + props.glow * 8}px rgb(255 255 255 / ${0.08 + props.glow * 0.2})`
					: undefined,
			}}
		>
			{props.children}
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
			className="grid size-9 shrink-0 place-items-center rounded-full text-foreground/80 transition hover:bg-white/10 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent [&_svg]:size-4"
		>
			{done ? props.done : props.children}
		</button>
	);
}

/** Space turns listening on and off, Enter sends what was said by hand,
 * Escape drops it. Not while typing in the draft, except Escape. */
function useShortcuts(voice: Voice, state: VoiceState) {
	useEffect(() => {
		const key = (event: KeyboardEvent) => {
			const typing = event.target instanceof HTMLTextAreaElement;
			if (event.key === "Escape") voice.clear();
			else if (typing || event.repeat) return;
			else if (event.key === " ") void voice.setListener(!state.listener);
			else if (event.key === "Enter" && !state.autoEnd) voice.send();
			else return;
			event.preventDefault();
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [voice, state.listener, state.autoEnd]);
}
