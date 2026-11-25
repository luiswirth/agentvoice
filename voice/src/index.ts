// voiceio, the library every audio client of VoiceIO builds on: an agent's
// ear and mouth, with their reflexes, and no transport and no UI. Its edges are audio and text, in and out; the host
// carries them, and plugs in the tier, such as ElevenLabs, which comes with it.
export {
	Conversation,
	type Events,
	type Fact,
	type Modes,
	type Names,
	type Options,
	type Settings,
	type State,
	type Utterance,
} from "./conversation.ts";
export type { Cue } from "./cues.ts";
export { Cues } from "./cues.ts";
export { checkKey, KeyRefused, Scribe, Speech } from "./elevenlabs.ts";
export { Fingerprints } from "./fingerprints.ts";
export type { Input } from "./listener.ts";
export { type Model, REDIMNET2, SILERO, SMART_TURN } from "./models.ts";
export {
	type FromFingerprints,
	type FromTurns,
	type Port,
	type Reflexes,
	serveFingerprints,
	serveTurns,
	type ToFingerprints,
	type ToTurns,
} from "./reflexes.ts";
export { reflexive } from "./reflexive.ts";
export { Resampler } from "./resampler.ts";
export type { Heard, Message } from "./speaker.ts";
export { speech } from "./speech.ts";
export { memory, type Store } from "./store.ts";
export * from "./tier.ts";
