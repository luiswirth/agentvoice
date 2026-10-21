// Voice's controls, one row: the listener, the speaker, and whether turns end
// by themselves, then what is being heard or read.
import {
	CornerDownLeft,
	Mic,
	MicOff,
	SendHorizontal,
	SkipForward,
	Volume2,
	VolumeOff,
	X,
} from "lucide-react";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import type { Voice } from "./voice.ts";

export function VoiceBar({ voice }: { voice: Voice }) {
	const state = useSyncExternalStore(voice.watch, () => voice.state);
	const said = [state.draft, state.hearing].filter(Boolean).join(" ");
	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center gap-1">
				<Button
					size="icon"
					variant={state.listener ? "secondary" : "ghost"}
					aria-pressed={state.listener}
					disabled={state.switching === "listener"}
					title={state.listener ? "Stop listening" : "Listen"}
					onClick={() => void voice.setListener(!state.listener)}
				>
					{state.listener ? <Mic /> : <MicOff />}
				</Button>
				<Button
					size="icon"
					variant={state.speaker ? "secondary" : "ghost"}
					aria-pressed={state.speaker}
					title={state.speaker ? "Stop reading aloud" : "Read aloud"}
					onClick={() => void voice.setSpeaker(!state.speaker)}
				>
					{state.speaker ? <Volume2 /> : <VolumeOff />}
				</Button>
				<Button
					size="icon"
					variant={state.autoEnd ? "secondary" : "ghost"}
					aria-pressed={state.autoEnd}
					title={
						state.autoEnd
							? "Turns end after a pause. Click to send them yourself"
							: "You send what you said. Click to end turns after a pause"
					}
					onClick={() => voice.setAutoEnd(!state.autoEnd)}
				>
					<CornerDownLeft />
				</Button>
				<p
					className={`min-w-0 flex-1 truncate px-2 text-sm ${state.hearing ? "" : "text-muted-foreground"}`}
				>
					{said}
				</p>
				{said && !state.autoEnd && (
					<>
						<Button
							size="icon"
							variant="ghost"
							title="Drop"
							onClick={() => voice.clear()}
						>
							<X />
						</Button>
						<Button size="icon" title="Send" onClick={() => voice.send()}>
							<SendHorizontal />
						</Button>
					</>
				)}
				{state.reading !== null && (
					<Button
						size="icon"
						variant="ghost"
						title="Skip this message"
						onClick={() => voice.skip()}
					>
						<SkipForward />
					</Button>
				)}
			</div>
			{state.error && (
				<p className="px-2 text-sm text-destructive">{state.error}</p>
			)}
		</div>
	);
}
