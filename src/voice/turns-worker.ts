// Turn detection off the page's thread.
import { SILERO, SMART_TURN, serveTurns } from "voice-core";
import { fetchModel, type Scope, setUpOnnxRuntime, within } from "./onnx.ts";

setUpOnnxRuntime();
serveTurns(
	within(self as unknown as Scope),
	Promise.all([fetchModel(SILERO), fetchModel(SMART_TURN)]),
);
