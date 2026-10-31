// Voice as a playback bar of two parts: listening on the left, speaking on
// the right, each a pill of its own, which join into one as both are on, a
// conversation. Above them, large, what the person is saying and has not yet
// sent: the agent's words belong to its harness. The two voices show as
// light, the person's warm and the agent's cool: a glow behind the page, the
// switch of each, and a strip of the last seconds of both. Once the agent
// named voices, the one heard now shows by name above the words. The system's
// media controls work it too, so that it needs no looking at. With turns
// ended by hand the left switch records: one message at a time, sent or
// deleted from under the words.
import {
	Check,
	Copy,
	CornerDownLeft,
	Globe,
	Mic,
	MicOff,
	Pause,
	Play,
	RotateCcw,
	SkipForward,
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

export function VoiceBar({ voice }: { voice: Voice }) {
	const state = useSyncExternalStore(voice.watch, () => voice.state);
	const root = useRef<HTMLDivElement>(null);
	const strip = useRef<HTMLCanvasElement>(null);
	useLevels(voice, root, strip);
	useShortcuts(voice, state);
	useEffect(() => {
		showMedia(now(state) || doing(state) || "voice", mode(state));
	}, [state]);
	return (
		<div ref={root} className="flex min-h-0 flex-1 flex-col items-center gap-4">
			<Aura />
			<Who state={state} />
			<Now voice={voice} state={state} />
			{state.error && <p className="text-sm text-destructive">{state.error}</p>}
			<Missed voice={voice} state={state} />
			<Status voice={voice} state={state} />
			<canvas
				ref={strip}
				aria-hidden
				className="h-10 w-full max-w-xl shrink-0"
			/>
			<Bar voice={voice} state={state} />
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

function doing(state: VoiceState): string {
	if (!state.autoEnd && state.recording) return "recording";
	if (state.hearing) return `hearing ${who(state)?.name ?? "you"}`;
	if (state.reading !== null) return state.held ? "paused" : "speaking";
	if (state.draft) return "your draft";
	if (state.progress === "working") return "agent working";
	if (state.progress === "sent") return "sent";
	if (state.listener) return "listening";
	if (state.speaker) return "waiting";
	return "";
}

function now(state: VoiceState): string {
	return [state.draft, state.hearing].filter(Boolean).join(" ");
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
 * `--agent-level` on `root`, and their last seconds drawn on `strip`. */
function useLevels(
	voice: Voice,
	root: RefObject<HTMLDivElement | null>,
	strip: RefObject<HTMLCanvasElement | null>,
) {
	useEffect(() => {
		// Rises fast and falls slowly, as a meter does.
		const ease = (from: number, to: number) =>
			from + (to - from) * (to > from ? 0.5 : 0.1);
		const history: Level[] = [];
		let you = 0;
		let agent = 0;
		let pushed = 0;
		let frame = requestAnimationFrame(function tick(time) {
			frame = requestAnimationFrame(tick);
			you = ease(you, voice.state.listener ? voice.state.level : 0);
			agent = ease(agent, voice.speakerLevel());
			root.current?.style.setProperty("--you-level", you.toFixed(3));
			root.current?.style.setProperty("--agent-level", agent.toFixed(3));
			if (time - pushed < STEP) return;
			pushed = time;
			history.push({ you, agent });
			if (history.length > 400) history.shift();
			if (strip.current) draw(strip.current, history);
		});
		return () => cancelAnimationFrame(frame);
	}, [voice, root, strip]);
}

type Level = { you: number; agent: number };

/** Milliseconds per bar of the strip. */
const STEP = 70;

/** The strip: a bar per step, the newest on the right, each in the colour of
 * whichever voice was louder, fading into the past. */
function draw(canvas: HTMLCanvasElement, history: Level[]) {
	const scale = devicePixelRatio;
	const width = canvas.clientWidth * scale;
	const height = canvas.clientHeight * scale;
	if (canvas.width !== width || canvas.height !== height) {
		canvas.width = width;
		canvas.height = height;
	}
	const context = canvas.getContext("2d");
	if (context === null) return;
	const colors = getComputedStyle(canvas);
	const you = colors.getPropertyValue("--you");
	const agent = colors.getPropertyValue("--agent");
	context.clearRect(0, 0, width, height);
	const bar = 3 * scale;
	const pitch = 6 * scale;
	const bars = Math.floor(width / pitch);
	for (let i = 0; i < bars; i++) {
		const level = history[history.length - 1 - i];
		const x = width - (i + 1) * pitch + (pitch - bar) / 2;
		const louder = Math.max(level?.you ?? 0, level?.agent ?? 0);
		context.globalAlpha = (1 - i / bars) ** 1.5;
		// Silence draws nothing, so that no line runs through.
		if (level === undefined || louder < 0.03) continue;
		const h = Math.max(2 * scale, Math.min(1, louder * 1.4) * height);
		context.fillStyle = level.you >= level.agent ? you : agent;
		context.beginPath();
		context.roundRect(x, (height - h) / 2, bar, h, bar / 2);
		context.fill();
	}
}

/** Both voices as light behind the page, each brighter as it is louder. */
function Aura() {
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
				className="absolute bottom-0 h-[70vh] w-[90vmax]"
				style={glow("--agent", "--agent-level", "75%")}
			/>
		</div>
	);
}

/** What is happening now, large: the person's words, to send or drop by
 * hand when turns don't end by themselves. */
function Now({ voice, state }: { voice: Voice; state: VoiceState }) {
	const base =
		"w-full min-h-0 flex-1 overflow-y-auto text-2xl leading-snug font-light text-balance";
	if (!state.autoEnd) return <Recorder voice={voice} state={state} />;
	const said = Boolean(state.draft || state.hearing);
	if (said) {
		return (
			<div className="flex min-h-0 w-full flex-1 flex-col gap-3 text-2xl leading-snug font-light">
				<textarea
					aria-label="What you said, to edit before sending"
					className="min-h-0 flex-1 resize-none bg-transparent outline-none"
					value={state.draft}
					onChange={(event) => voice.setDraft(event.target.value)}
				/>
				{state.hearing && (
					<p className="text-muted-foreground">{state.hearing}</p>
				)}
				<div className="flex shrink-0 justify-end gap-2 text-sm font-normal">
					<button
						type="button"
						title="Send it to your agent (Enter)"
						className="flex h-9 items-center gap-2 rounded-full bg-you px-4 font-medium text-black shadow-[0_0_24px_-4px_var(--you)] transition hover:brightness-110"
						onClick={() => voice.send()}
					>
						Send
						<CornerDownLeft className="size-4 opacity-60" />
					</button>
				</div>
			</div>
		);
	}
	if (said) {
		return (
			<p className={base}>
				{state.draft}{" "}
				<span className="text-muted-foreground">{state.hearing}</span>
			</p>
		);
	}
	return (
		<p
			className={`${base} flex items-center justify-center text-center text-muted-foreground/70`}
		>
			{hint(state)}
		</p>
	);
}

/** Turns ended by hand: a message recorded, then sent or deleted. */
function Recorder({ voice, state }: { voice: Voice; state: VoiceState }) {
	const said = Boolean(state.draft || state.hearing);
	if (!said && !state.recording) {
		return (
			<div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-6 text-center">
				{state.ended && <Ended voice={voice} ended={state.ended} />}
				<p className="text-2xl leading-snug font-light text-balance text-muted-foreground/70">
					{state.ended
						? "Tap the mic to record another."
						: "Tap the mic to record a message."}
				</p>
			</div>
		);
	}
	return (
		<div className="flex min-h-0 w-full flex-1 flex-col gap-3 text-2xl leading-snug font-light">
			{said && state.recording ? (
				// Editing waits until the recording stops, so the words heard
				// so far read on as one text.
				<p className="min-h-0 flex-1 overflow-y-auto">
					{state.draft}{" "}
					<span className="text-muted-foreground">{state.hearing}</span>
				</p>
			) : said ? (
				<>
					<textarea
						aria-label="Your message, to edit before sending"
						className="min-h-0 flex-1 resize-none bg-transparent outline-none"
						value={state.draft}
						onChange={(event) => voice.setDraft(event.target.value)}
					/>
					{state.hearing && (
						<p className="text-muted-foreground">{state.hearing}</p>
					)}
				</>
			) : (
				<p className="flex flex-1 items-center justify-center text-center text-balance text-muted-foreground/70">
					Say your message.
				</p>
			)}
			<div className="flex shrink-0 items-center gap-2 text-sm font-normal">
				<p className="mr-auto flex items-center gap-2 text-muted-foreground">
					{state.recording ? (
						<>
							<span className="size-2 animate-pulse rounded-full bg-red-500 shadow-[0_0_8px_var(--color-red-500)]" />
							Recording
						</>
					) : (
						"Tap the mic to add more"
					)}
				</p>
				{said && (
					<>
						<button
							type="button"
							title="Delete this message (Escape)"
							className="flex h-9 items-center gap-2 rounded-full px-4 text-foreground/80 transition hover:bg-white/10 hover:text-foreground"
							onClick={() => voice.clear()}
						>
							<Trash2 className="size-4" />
							Delete
						</button>
						<button
							type="button"
							title="Send it to your agent (Enter)"
							className="flex h-9 items-center gap-2 rounded-full bg-you px-4 font-medium text-black shadow-[0_0_24px_-4px_var(--you)] transition hover:brightness-110"
							onClick={() => voice.send()}
						>
							Send
							<CornerDownLeft className="size-4 opacity-60" />
						</button>
					</>
				)}
			</div>
		</div>
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
		<div className="flex max-w-md flex-col items-center gap-2 text-sm">
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

function hint({ listener, speaker, autoEnd }: VoiceState): string {
	if (listener && autoEnd) return "Speak, and your words go to your agent.";
	if (speaker) return "Your agent's messages are read aloud as they arrive.";
	return "Turn on listening, speaking, or both.";
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
		<p className="flex max-w-xl items-center gap-2 text-sm text-muted-foreground">
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

/** The mode, what is going on in it, and sharing the trace. */
function Status({ voice, state }: { voice: Voice; state: VoiceState }) {
	const dot =
		state.listener && state.speaker
			? "linear-gradient(90deg, var(--you) 50%, var(--agent) 50%)"
			: state.listener
				? "var(--you)"
				: state.speaker
					? "var(--agent)"
					: "var(--muted-foreground)";
	return (
		<div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs tracking-widest whitespace-nowrap text-muted-foreground uppercase sm:gap-x-3">
			<p className="flex items-center gap-2">
				<span
					className="size-2 rounded-full transition-[background] duration-500"
					style={{ background: dot }}
				/>
				{mode(state)}
				{doing(state) && (
					<span className="hidden text-muted-foreground/60 sm:inline">
						· {doing(state)}
					</span>
				)}
			</p>
			<TierChoice voice={voice} state={state} />
			{state.tier === "local" && state.engineVoices.length > 1 && (
				<EngineVoice voice={voice} state={state} />
			)}
			{state.tier === "elevenlabs" && <Languages voice={voice} state={state} />}
			<button
				type="button"
				aria-pressed={state.sharing}
				title="Send your agent a trace of what voice does, with the audio it heard, now and with each message, so that it can improve voice"
				className={`rounded-full px-2 py-0.5 tracking-widest uppercase transition hover:bg-white/10 hover:text-foreground ${state.sharing ? "bg-white/10 text-foreground" : "text-muted-foreground/60"}`}
				onClick={() => voice.share(!state.sharing)}
			>
				{state.sharing ? "sharing trace" : "share trace"}
			</button>
			<button
				type="button"
				aria-pressed={state.sounds}
				title="Short sounds for what happens, such as your message going out and your agent working on it"
				className={`rounded-full px-2 py-0.5 tracking-widest uppercase transition hover:bg-white/10 hover:text-foreground ${state.sounds ? "text-muted-foreground" : "text-muted-foreground/40 line-through"}`}
				onClick={() => voice.setSounds(!state.sounds)}
			>
				sounds
			</button>
		</div>
	);
}

/** Where transcription and speech synthesis run: ElevenLabs, or an engine
 * in the session, which a press switches between. */
function TierChoice({ voice, state }: { voice: Voice; state: VoiceState }) {
	const local = state.tier === "local";
	return (
		<button
			type="button"
			title="Where your voice is heard and spoken: on ElevenLabs, with your key, or by an engine your agent runs, in English only. Press to switch."
			aria-label={`Voice on ${local ? "an engine your agent runs" : "ElevenLabs"}`}
			className="rounded-full px-2 py-0.5 tracking-widest uppercase transition hover:bg-white/10 hover:text-foreground text-muted-foreground/60"
			onClick={() => voice.setTier(local ? "elevenlabs" : "local")}
		>
			{local ? `local${state.engine ? "" : " · no engine yet"}` : "elevenlabs"}
		</button>
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
	// The name shows as a pill; the select over it, unseen, opens the
	// browser's own list, and is as wide as the name rather than the longest.
	return (
		<label
			title="The voice your agent speaks with, kept in this browser"
			className="relative cursor-pointer rounded-full px-2 py-0.5 tracking-widest uppercase text-muted-foreground/60 transition hover:bg-white/10 hover:text-foreground"
		>
			{name(state.engineVoice ?? "")}
			<select
				aria-label="The voice your agent speaks with"
				className="absolute inset-0 cursor-pointer opacity-0"
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
		</label>
	);
}

const names = new Intl.DisplayNames(["en"], { type: "language" });

/** The languages the person speaks, for transcription: detected, shown as
 * the globe alone, or typed as codes such as `en, de`, the most likely first. */
function Languages({ voice, state }: { voice: Voice; state: VoiceState }) {
	const [editing, setEditing] = useState<string | null>(null);
	const title =
		"The languages you speak, the most likely first, as codes such as en, de: transcription hears only these. Empty is automatic.";
	if (editing === null)
		return (
			<button
				type="button"
				title={title}
				aria-label={`Languages: ${state.languages.join(", ") || "detected"}`}
				className="flex items-center gap-1.5 rounded-full px-2 py-0.5 tracking-widest uppercase transition hover:bg-white/10 hover:text-foreground text-muted-foreground/60"
				onClick={() => setEditing(state.languages.join(", "))}
			>
				<Globe className="size-3" />
				{state.languages.join(" · ")}
			</button>
		);
	const save = () => {
		const codes = editing
			.toLowerCase()
			.split(/[\s,]+/)
			.filter((code) => /^[a-z]{2,3}$/.test(code) && names.of(code) !== code);
		void voice.setLanguages([...new Set(codes)]);
		setEditing(null);
	};
	return (
		<input
			// biome-ignore lint/a11y/noAutofocus: it opens at the person's click
			autoFocus
			aria-label="The languages you speak"
			title={title}
			placeholder="en, de"
			className="w-24 rounded-full bg-white/10 px-2 py-0.5 text-xs tracking-normal text-foreground normal-case outline-none placeholder:text-muted-foreground/60"
			value={editing}
			onChange={(event) => setEditing(event.target.value)}
			onBlur={save}
			onKeyDown={(event) => {
				if (event.key === "Enter") save();
				if (event.key === "Escape") setEditing(null);
			}}
		/>
	);
}

/** The two parts: listening and speaking, apart, or joined while both are on. */
function Bar({ voice, state }: { voice: Voice; state: VoiceState }) {
	const manual = !state.autoEnd;
	const listening = manual ? state.recording : state.listener;
	const joined = listening && state.speaker;
	const reading = state.reading !== null;
	return (
		<div
			className={`flex w-full max-w-xl justify-center transition-[gap] duration-500 ${joined ? "gap-0" : "gap-2 sm:gap-3"}`}
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
				<TurnEnd voice={voice} state={state} />
				{!manual && (state.draft || state.hearing) ? (
					<Small
						label="Drop what you said so far (Escape): it can still be copied"
						onClick={() => voice.clear()}
					>
						<X />
					</Small>
				) : (
					<Small
						label="Copy your last transcript"
						disabled={!state.last}
						onClick={() => voice.copyLast()}
						done={<Check />}
					>
						<Copy />
					</Small>
				)}
			</Part>
			<Part side="right" on={state.speaker} joined={joined} color="--agent">
				<Small
					label="Read the last message again"
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
	const inner = props.joined ? "4px" : "999px";
	const left = props.side === "left";
	return (
		<div
			className={`flex shrink-0 items-center gap-0.5 border p-1 sm:gap-1 sm:p-1.5 ${left ? "pr-1.5 sm:pr-2" : ""} shadow-2xl shadow-black/60 backdrop-blur-xl transition-all duration-500 ${props.on ? "bg-white/[0.08]" : "border-white/10 bg-white/[0.03]"}`}
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
			className={`grid size-11 shrink-0 place-items-center rounded-full sm:size-12 transition-colors duration-300 [&_svg]:size-5 ${props.on ? "text-black" : "bg-white/10 text-foreground/70 hover:bg-white/15 hover:text-foreground"} ${props.busy ? "animate-pulse" : ""} ${props.working ? "animate-[working_2.4s_ease-in-out_infinite]" : ""}`}
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

/** Whether a turn ends at a pause or when the person sends it: a setting of
 * listening, so a choice of two rather than a button. */
function TurnEnd({ voice, state }: { voice: Voice; state: VoiceState }) {
	const options = [
		{ auto: true, label: "auto", title: "Your turn ends when you pause" },
		{
			auto: false,
			label: "manual",
			title: "Record each message with the microphone, then send it",
		},
	];
	return (
		<fieldset
			aria-label="How your turn ends"
			className={`relative m-0 grid min-w-0 border-0 h-8 shrink-0 grid-cols-2 rounded-full bg-black/40 p-0.5 text-xs transition-opacity ${state.listener || !state.autoEnd ? "" : "opacity-60"}`}
		>
			<span
				aria-hidden
				className="absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-full bg-white/15 shadow-sm transition-transform duration-300 ease-out"
				style={{ transform: state.autoEnd ? "none" : "translateX(100%)" }}
			/>
			{options.map(({ auto, label, title }) => (
				<button
					key={label}
					type="button"
					aria-pressed={state.autoEnd === auto}
					title={title}
					className={`relative rounded-full px-1.5 transition-colors sm:px-2.5 ${state.autoEnd === auto ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
					onClick={() => voice.setAutoEnd(auto)}
				>
					{label}
				</button>
			))}
		</fieldset>
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
			className="grid size-8 shrink-0 place-items-center rounded-full text-foreground/80 transition hover:bg-white/10 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent sm:size-9 [&_svg]:size-4"
		>
			{done ? props.done : props.children}
		</button>
	);
}

/** Space turns listening, or recording, on and off, Enter sends what was said by hand,
 * Escape drops it. Not while typing in the draft, except Escape, nor in a
 * field. */
function useShortcuts(voice: Voice, state: VoiceState) {
	useEffect(() => {
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
	}, [voice, state.listener, state.autoEnd, state.recording]);
}
