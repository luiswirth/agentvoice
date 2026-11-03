// The voice fingerprint off the page's thread. It starts once the page tells
// it its own address, against which the model's is, since the page serves it.
import { REDIMNET2, serveFingerprints } from "voice-core";
import { fetchModel, type Scope, setUpOnnxRuntime, within } from "./onnx.ts";

setUpOnnxRuntime();
const scope = self as unknown as Scope;
scope.onmessage = ({ data: page }: MessageEvent<string>) =>
	serveFingerprints(
		within(scope),
		fetchModel({ ...REDIMNET2, url: new URL(REDIMNET2.url, page).href }),
	);
