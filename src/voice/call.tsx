// Voice as a phone call, since everyone knows how one works: who you talk
// with at the top, large, with what is happening under it, and the buttons of
// a call at the bottom: mute or push to talk, speaker, hands-free, more, and
// the red one that hangs up, which leaves. No text shows: the conversation
// belongs to the agent's harness, as a call shows none. What is set once, such
// as the tier, waits behind more. The system's media controls work it too, as
// headphones do on a call: a tap mutes, or sends.
import {
	AudioLines,
	Check,
	Copy,
	Download,
	Ellipsis,
	Mic,
	MicOff,
	PhoneOff,
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
import { agent } from "./protocol.ts";
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

/** A message said in the session, by the person or an agent: another
 * person's words never show, as the page never reads them out. */
export type Turn = {
	n: number;
	from: string;
	/** Whether the person said it. */
	mine: boolean;
	text: string;
};

/** The session as the page sees it. */
export type Room = {
	/** The others in it now. */
	people: Present[];
	/** What was said in it, oldest first. */
	turns: Turn[];
	/** The agents in the order they first spoke, which picks each one's
	 * shade. */
	speakers: string[];
	link: string;
	leave: () => void;
};

export function Call({
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
	const people = (room?.people ?? []).filter((person) => !person.engine);
	const agents = people.filter((person) => agent(person.name));
	const speakers = room?.speakers ?? [];
	const reader = room?.turns.find((turn) => turn.n === state.reading)?.from;
	const now = status(state, reader ? label(reader) : null, agents);
	const title = together(people.map((person) => label(person.name)));
	useEffect(() => {
		showMedia(said(state) || now, title || "voice");
	}, [state, now, title]);
	return (
		<div
			ref={root}
			className="relative mx-auto flex min-h-0 w-full max-w-md flex-1 flex-col items-center"
		>
			<Aura
				you={state.listener}
				agent={state.speaker}
				reader={reader ? shade(speakers, reader) : undefined}
				working={state.progress === "working" && state.reading === null}
			/>
			<header className="flex w-full flex-col items-center gap-5 pt-[8vh] text-center">
				<Faces
					people={people}
					speakers={speakers}
					reader={reader}
					progress={state.progress}
				/>
				<div className="flex flex-col items-center gap-1.5">
					{people.length < 2 && (
						<h1 className="text-3xl font-light tracking-tight text-balance sm:text-4xl">
							{title || "Only you"}
						</h1>
					)}
					<p
						aria-live="polite"
						className="flex items-center gap-2 text-base text-muted-foreground"
					>
						<span>{now}</span>
						<span aria-hidden className="opacity-50">
							·
						</span>
						<Timer />
					</p>
					{state.error && (
						<p className="mt-2 max-w-sm text-sm text-pretty text-destructive">
							{state.error}
						</p>
					)}
				</div>
			</header>
			<div className="min-h-0 flex-1" />
			<Buttons
				voice={voice}
				state={state}
				more={() => setSettings(true)}
				leave={room?.leave}
			/>
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

/** Names as a call shows a group: "claude", "claude & codex", "claude,
 * codex & ben". */
function together(names: string[]): string {
	if (names.length < 2) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} & ${names.at(-1)}`;
}

function said(state: VoiceState): string {
	return [state.draft, state.hearing].filter(Boolean).join(" ");
}

/** What is happening on the call, in a few words, where a call shows that it
 * rings or how long it has run. */
function status(
	state: VoiceState,
	reader: string | null,
	agents: Present[],
): string {
	if (state.blocked) return "Tap to hear";
	if (state.hearing) return `Hearing ${who(state)?.name ?? "you"}`;
	// In a call with one, the name above already says who.
	if (state.reading !== null)
		return agents.length > 1 && reader ? `${reader} is speaking` : "Speaking";
	if (state.progress === "working") return "Thinking…";
	if (state.progress === "sent")
		return agents.length > 1 ? "Sent" : "Sent, not heard yet";
	if (state.listener) return "Listening";
	if (!state.autoEnd) return state.speaker ? "Hold to talk" : "Speaker off";
	return state.speaker ? "Muted" : "Muted, speaker off";
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
		name: voice === null ? "a new voice" : `voice ${voice}`,
		named: false,
	};
}

/** How long the call has run, as a call shows it. */
function Timer() {
	const [start] = useState(() => Date.now());
	const [now, setNow] = useState(start);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const seconds = Math.floor((now - start) / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		<span className="tabular-nums">
			{hours > 0 ? `${hours}:${pad(minutes % 60)}` : minutes}:
			{pad(seconds % 60)}
		</span>
	);
}

/** The levels of both voices, eased, as the CSS variables `--you-level` and
 * `--agent-level`, each frame on the elements in `root` marked `data-meter`,
 * which show them. Set on `root` itself, they would make the browser restyle
 * the whole page every frame, which a phone can't keep up with. */
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
			const values: [string, string][] = [
				["--you-level", you.toFixed(3)],
				["--agent-level", agent.toFixed(3)],
			];
			const meters =
				root.current?.querySelectorAll<HTMLElement>("[data-meter]");
			for (const meter of meters ?? [])
				for (const [name, value] of values)
					if (meter.style.getPropertyValue(name) !== value)
						meter.style.setProperty(name, value);
		});
		return () => cancelAnimationFrame(frame);
	}, [voice, root]);
}

/** Both voices as light behind the page, faint while on and brighter as
 * each is louder, the agent's breathing while it works. */
function Aura({
	you,
	agent,
	reader,
	working,
}: {
	you: boolean;
	agent: boolean;
	/** The shade of the agent read now. */
	reader: CSSProperties | undefined;
	working: boolean;
}) {
	const glow = (
		color: string,
		level: string,
		at: string,
		on: boolean,
	): CSSProperties => ({
		left: at,
		background: `radial-gradient(closest-side, color-mix(in oklch, var(${color}) 40%, transparent), transparent)`,
		opacity: `calc(${on ? 0.1 : 0} + var(${level}, 0) * 0.7)`,
		transform: `translate(-50%, 50%) scale(calc(0.85 + var(${level}, 0) * 0.35))`,
	});
	return (
		<div
			aria-hidden
			className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
		>
			<div
				data-meter
				className="absolute bottom-0 h-[60vh] w-[90vmax]"
				style={glow("--you", "--you-level", "50%", you)}
			/>
			<div
				data-meter
				className={`absolute top-0 h-[60vh] w-[90vmax] ${working ? "animate-[breathe_2.4s_ease-in-out_infinite]" : ""}`}
				style={{
					...reader,
					...glow("--agent", "--agent-level", "50%", agent || working),
					transform: `translate(-50%, -50%) scale(calc(0.85 + var(--agent-level, 0) * 0.35))`,
				}}
			/>
		</div>
	);
}

/** Who is on the call, each as a round face with their initial, as a call
 * shows a contact without a photo: an agent in its own shade, glowing with
 * its voice while it speaks and breathing while it works; another person in
 * the person's colour. In a group, the faces are smaller, each with its name
 * under it, in place of the one name of a call with one. */
function Faces({
	people,
	speakers,
	reader,
	progress,
}: {
	people: Present[];
	speakers: string[];
	reader: string | undefined;
	progress: Progress;
}) {
	const group = people.length > 1;
	if (people.length === 0)
		return (
			<div className="grid size-28 place-items-center rounded-full bg-white/[0.06] text-4xl font-light text-muted-foreground">
				?
			</div>
		);
	return (
		<ul className="flex flex-wrap items-start justify-center gap-5">
			{people.map((person) => {
				const isAgent = agent(person.name);
				const speaking = person.name === reader;
				const working = isAgent && progress === "working" && !person.receiving;
				const name = label(person.name);
				return (
					<li
						key={person.name}
						title={`${person.name}: ${person.receiving ? "here, listening" : "busy"}`}
						className="flex animate-[arrive_0.4s_ease-out] flex-col items-center gap-2"
						style={
							isAgent
								? shade(speakers, person.name)
								: ({ "--agent": "var(--you)" } as CSSProperties)
						}
					>
						<div
							data-meter={speaking ? "" : undefined}
							className={`grid place-items-center rounded-full font-light text-white transition-[box-shadow] duration-150 ${group ? "size-[4.5rem] text-3xl" : "size-28 text-5xl"} ${working ? "animate-[breathe_2.4s_ease-in-out_infinite]" : ""}`}
							style={{
								background:
									"linear-gradient(160deg, color-mix(in oklch, var(--agent) 75%, white), color-mix(in oklch, var(--agent) 55%, black))",
								boxShadow: speaking
									? "0 0 0 calc(var(--agent-level, 0) * 14px) color-mix(in oklch, var(--agent) 30%, transparent), 0 0 calc(12px + var(--agent-level, 0) * 50px) color-mix(in oklch, var(--agent) 60%, transparent)"
									: undefined,
							}}
						>
							{name.charAt(0).toUpperCase()}
						</div>
						{group && <span className="text-lg font-light">{name}</span>}
					</li>
				);
			})}
		</ul>
	);
}

/** The style that shows the agent `from` in its own shade of the agent
 * colour, by its place among the `speakers`, as its voice is picked: one not
 * heard yet takes the next. */
function shade(speakers: string[], from: string): CSSProperties {
	const n = speakers.indexOf(from);
	const place = (n < 0 ? speakers.length : n) % 4;
	return { "--agent": `var(--agent-${place})` } as CSSProperties;
}

/** A name in the session as the person reads it: without the person's own
 * prefix, which every agent they invite carries. */
function label(name: string): string {
	const slash = name.indexOf("/");
	return slash < 0 ? name : name.slice(slash + 1);
}

/** The buttons of a call: on top mute, speaker and hands-free; under them
 * more and the red one that hangs up. Hands-free listens all along and sends
 * as the person pauses; without it, the first button is push to talk, which
 * listens while held and sends once let go. A button is lit white while it
 * does what its name says, as on a phone. */
function Buttons({
	voice,
	state,
	more,
	leave,
}: {
	voice: Voice;
	state: VoiceState;
	more: () => void;
	leave: (() => void) | undefined;
}) {
	const handsFree = state.autoEnd;
	return (
		<nav
			aria-label="Call"
			className="grid shrink-0 grid-cols-3 justify-items-center gap-x-8 gap-y-6 pb-2"
		>
			{handsFree ? (
				<Round
					label="mute"
					title={state.listener ? "Mute (Space)" : "Unmute (Space)"}
					lit={!state.listener}
					busy={state.switching === "listener"}
					onClick={() => void voice.setListener(!state.listener)}
				>
					{state.listener ? <Mic /> : <MicOff />}
				</Round>
			) : (
				<PushToTalk voice={voice} state={state} />
			)}
			<Round
				label="speaker"
				title={
					state.speaker
						? "Speaker on: you hear your agent. Tap to stop hearing it."
						: "Speaker off: your agent isn't read aloud. Tap to hear it."
				}
				lit={state.speaker}
				onClick={() => void voice.setSpeaker(!state.speaker)}
			>
				{state.speaker ? <Volume2 /> : <VolumeX />}
			</Round>
			<Round
				label="hands-free"
				title={
					handsFree
						? "Hands-free: your words go out as you pause. Tap for push to talk."
						: "Push to talk: hold to talk, let go to send. Tap for hands-free."
				}
				lit={handsFree}
				onClick={() => void voice.setAutoEnd(!handsFree)}
			>
				<AudioLines />
			</Round>
			<Round label="more" title="Settings" lit={false} onClick={more}>
				<Ellipsis />
			</Round>
			{leave && <HangUp leave={leave} />}
		</nav>
	);
}

/** Push to talk: listening while held, by touch, mouse or Space, and sent
 * once let go. */
function PushToTalk({ voice, state }: { voice: Voice; state: VoiceState }) {
	const held = state.listener || state.switching === "listener";
	return (
		<button
			type="button"
			title="Hold to talk, let go to send (hold Space)"
			aria-label="Hold to talk"
			aria-pressed={held}
			className="group flex touch-none flex-col items-center gap-2 text-xs text-foreground/80 select-none [-webkit-touch-callout:none]"
			onPointerDown={(event) => {
				event.currentTarget.setPointerCapture(event.pointerId);
				void voice.press();
			}}
			onPointerUp={() => voice.release()}
			onPointerCancel={() => voice.release()}
			onContextMenu={(event) => event.preventDefault()}
		>
			<span
				data-meter={held ? "" : undefined}
				className={`grid size-[4.5rem] place-items-center rounded-full transition-[background-color,transform] duration-150 [&_svg]:size-7 ${held ? "scale-110 bg-you text-black" : "bg-white/[0.12] text-white backdrop-blur-xl group-hover:bg-white/20"}`}
				style={
					held
						? {
								boxShadow:
									"0 0 0 calc(var(--you-level, 0) * 12px) color-mix(in oklch, var(--you) 30%, transparent), 0 0 calc(10px + var(--you-level, 0) * 40px) color-mix(in oklch, var(--you) 60%, transparent)",
							}
						: undefined
				}
			>
				<Mic />
			</span>
			hold to talk
		</button>
	);
}

/** A round button of a call, with its name under it. */
function Round(props: {
	label: string;
	title: string;
	lit: boolean;
	busy?: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			title={props.title}
			aria-label={props.title}
			aria-pressed={props.lit}
			disabled={props.busy}
			onClick={props.onClick}
			className="group flex flex-col items-center gap-2 text-xs text-foreground/80"
		>
			<span
				className={`grid size-[4.5rem] place-items-center rounded-full transition-colors duration-150 [&_svg]:size-7 ${props.lit ? "bg-white text-black" : "bg-white/[0.12] text-white backdrop-blur-xl group-hover:bg-white/20"} ${props.busy ? "animate-pulse" : ""}`}
			>
				{props.children}
			</span>
			{props.label}
		</button>
	);
}

/** Hanging up, which leaves the session. The agent can't follow into the
 * next one, so a second tap within a few seconds confirms it. */
function HangUp({ leave }: { leave: () => void }) {
	const [sure, setSure] = useState(false);
	useEffect(() => {
		if (!sure) return;
		const timer = setTimeout(() => setSure(false), 4000);
		return () => clearTimeout(timer);
	}, [sure]);
	return (
		<button
			type="button"
			title="Hang up: you leave the call"
			aria-label={sure ? "Tap again to hang up" : "Hang up"}
			onClick={() => (sure ? leave() : setSure(true))}
			className="flex flex-col items-center gap-2 text-xs text-foreground/80"
		>
			<span
				className={`grid size-[4.5rem] place-items-center rounded-full bg-[oklch(0.63_0.22_25)] text-white transition hover:brightness-110 [&_svg]:size-7 ${sure ? "ring-4 ring-[oklch(0.63_0.22_25)]/40" : ""}`}
			>
				<PhoneOff />
			</span>
			{sure ? "tap again" : "end"}
		</button>
	);
}

/** What is set once and then left: the last transcript, where
 * speech runs, its voice and languages, the sounds, the session's link, and
 * debugging. */
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
			className="m-auto max-h-[calc(100dvh-1.5rem)] w-[min(28rem,calc(100vw-1.5rem))] overflow-y-auto rounded-3xl border border-white/10 bg-neutral-900/90 p-0 text-foreground shadow-2xl shadow-black backdrop-blur-2xl backdrop:bg-black/50 backdrop:backdrop-blur-sm max-sm:mb-3"
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
					title="Last transcript"
					detail={
						state.last
							? `“${state.last.length > 60 ? `${state.last.slice(0, 60)}…` : state.last}”`
							: "Nothing said yet."
					}
				>
					<CopyLast voice={voice} disabled={!state.last} />
				</Row>
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
					<Row
						title="Voice"
						detail="The voice of the first agent to speak. Each other agent gets a different one."
					>
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
						detail="It is like a password: share it only with people you trust."
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

/** Copies the person's last transcript, sent or not, which is never lost. */
function CopyLast({ voice, disabled }: { voice: Voice; disabled: boolean }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [copied]);
	return (
		<button
			type="button"
			disabled={disabled}
			className="flex h-8 items-center gap-1.5 rounded-full bg-white/10 px-3 text-sm transition hover:bg-white/15 disabled:opacity-40"
			onClick={() => void voice.copyLast().then(() => setCopied(true))}
		>
			{copied ? <Check className="size-4" /> : <Copy className="size-4" />}
			{copied ? "Copied" : "Copy"}
		</button>
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

/** Space mutes and unmutes, or with push to talk, talks while held. Not in a
 * field, nor while the settings are open. */
function useShortcuts(voice: Voice, state: VoiceState, settings: boolean) {
	const handsFree = state.autoEnd;
	useEffect(() => {
		if (settings) return;
		const down = (event: KeyboardEvent) => {
			if (event.target instanceof HTMLInputElement || event.key !== " ") return;
			event.preventDefault();
			if (event.repeat) return;
			if (handsFree) void voice.setListener(!state.listener);
			else void voice.press();
		};
		const up = (event: KeyboardEvent) => {
			if (event.target instanceof HTMLInputElement || event.key !== " ") return;
			if (!handsFree) voice.release();
		};
		window.addEventListener("keydown", down);
		window.addEventListener("keyup", up);
		return () => {
			window.removeEventListener("keydown", down);
			window.removeEventListener("keyup", up);
		};
	}, [voice, state.listener, handsFree, settings]);
}
