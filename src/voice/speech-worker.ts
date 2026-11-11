// Speech detection alone off the page's thread: turn detection without
// Smart Turn, which gates what the ElevenLabs tier hears.
import { SILERO, serveTurns } from "voice-core";
import { fetchModel, type Scope, setUpOnnxRuntime, within } from "./onnx.ts";

setUpOnnxRuntime();
serveTurns(
	within(self as unknown as Scope),
	fetchModel(SILERO).then((silero) => [silero]),
);
