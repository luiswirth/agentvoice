// Voice's controls: two halves, Listen and Speak, each on or off on its own.
// Listen alone is transcription, Speak alone reading aloud, both a
// conversation. Above them, what is happening now: what is being heard, or
// the message being read.
import {
	Check,
	Copy,
	Mic,
	Pause,
	Play,
	RotateCcw,
	SendHorizontal,
	SkipForward,
	Volume2,
	X,
} from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { Voice, VoiceState } from "./voice.ts";

export function VoiceBar({ voice }: { voice: Voice }) {
	const state = useSyncExternalStore(voice.watch, () => voice.state);
	useShortcuts(voice, state);
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			<p className="text-sm text-muted-foreground">
				<span className="font-medium text-foreground">{mode(state)}</span>
				{doing(state) && ` · ${doing(state)}`}
			</p>
			<Now voice={voice} state={state} />
			{state.error && <p className="text-sm text-destructive">{state.error}</p>}
			<div className="grid gap-3 sm:grid-cols-2">
				<Listen voice={voice} state={state} />
				<Speak voice={voice} state={state} />
			</div>
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
	if (state.speaker) return "waiting for a message";
	return "";
}

/** What is happening now: the person's words, or the agent's being read. */
function Now({ voice, state }: { voice: Voice; state: VoiceState }) {
	const yours = state.draft || state.hearing;
	if (yours && !state.autoEnd) {
		return (
			<div className="flex min-h-0 flex-1 flex-col gap-1">
				<textarea
					aria-label="What you said, to edit before sending"
					className="min-h-0 flex-1 resize-none rounded-lg border bg-transparent p-3 text-lg"
					value={state.draft}
					onChange={(event) => voice.setDraft(event.target.value)}
				/>
				{state.hearing && (
					<p className="text-lg text-muted-foreground">{state.hearing}</p>
				)}
			</div>
		);
	}
	if (yours) {
		return (
			<p className="min-h-0 flex-1 overflow-y-auto text-lg">
				{state.draft}{" "}
				<span className="text-muted-foreground">{state.hearing}</span>
			</p>
		);
	}
	if (state.speaker && state.message) {
		return (
			<p
				className={`min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap text-lg ${state.reading === null ? "text-muted-foreground" : ""}`}
			>
				{state.message}
			</p>
		);
	}
	return (
		<p className="flex min-h-0 flex-1 items-center justify-center text-center text-muted-foreground">
			{hint(state)}
		</p>
	);
}

function hint({ listener, speaker }: VoiceState): string {
	if (listener) return "Speak, and your words go to your agent.";
	if (speaker) return "Your agent's messages are read aloud as they arrive.";
	return "Turn on Listen to speak to your agent, Speak to hear it, or both to talk.";
}

function Listen({ voice, state }: { voice: Voice; state: VoiceState }) {
	const said = Boolean(state.draft || state.hearing);
	return (
		<section className="flex flex-col gap-2 rounded-xl border p-3">
			<Button
				className="h-14 w-full text-base"
				variant={state.listener ? "default" : "outline"}
				aria-pressed={state.listener}
				disabled={state.switching === "listener"}
				onClick={() => void voice.setListener(!state.listener)}
			>
				<Mic />
				{state.listener ? "Listening" : "Listen"}
			</Button>
			<div className="h-1 overflow-hidden rounded-full bg-muted">
				<div
					className="h-full bg-primary transition-[width] duration-100"
					style={{ width: `${Math.round(state.level * 100)}%` }}
				/>
			</div>
			<div className="flex flex-wrap items-center justify-between gap-2 text-sm">
				<span className="text-muted-foreground">Send</span>
				<ToggleGroup
					variant="outline"
					size="sm"
					value={[state.autoEnd ? "auto" : "manual"]}
					onValueChange={(value: string[]) => {
						if (value[0]) voice.setAutoEnd(value[0] === "auto");
					}}
				>
					<ToggleGroupItem value="auto">After a pause</ToggleGroupItem>
					<ToggleGroupItem value="manual">By hand</ToggleGroupItem>
				</ToggleGroup>
			</div>
			{!state.autoEnd && (
				<div className="flex gap-2">
					<Button
						className="flex-1"
						disabled={!said}
						onClick={() => voice.send()}
					>
						<SendHorizontal />
						Send
					</Button>
					<Button
						variant="outline"
						disabled={!said}
						onClick={() => voice.clear()}
					>
						<X />
						Drop
					</Button>
				</div>
			)}
			<CopyLast voice={voice} state={state} />
		</section>
	);
}

function CopyLast({ voice, state }: { voice: Voice; state: VoiceState }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [copied]);
	return (
		<Button
			variant="ghost"
			size="sm"
			disabled={!state.last}
			title={state.last ?? undefined}
			onClick={() => void voice.copyLast().then(() => setCopied(true))}
		>
			{copied ? <Check /> : <Copy />}
			{copied ? "Copied" : "Copy last transcript"}
		</Button>
	);
}

function Speak({ voice, state }: { voice: Voice; state: VoiceState }) {
	const reading = state.reading !== null;
	return (
		<section className="flex flex-col gap-2 rounded-xl border p-3">
			<Button
				className="h-14 w-full text-base"
				variant={state.speaker ? "default" : "outline"}
				aria-pressed={state.speaker}
				onClick={() => void voice.setSpeaker(!state.speaker)}
			>
				<Volume2 />
				{state.speaker ? "Speaking" : "Speak"}
			</Button>
			<div className="h-1" />
			<div className="flex gap-2">
				<Button
					className="flex-1"
					variant="outline"
					disabled={!reading}
					onClick={() => voice.hold(!state.held)}
				>
					{state.held ? <Play /> : <Pause />}
					{state.held ? "Resume" : "Pause"}
				</Button>
				<Button
					variant="outline"
					disabled={!reading}
					onClick={() => voice.skip()}
				>
					<SkipForward />
					Skip
				</Button>
			</div>
			<Button
				variant="ghost"
				size="sm"
				disabled={!state.message}
				onClick={() => void voice.replay()}
			>
				<RotateCcw />
				Read last message again
			</Button>
		</section>
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
