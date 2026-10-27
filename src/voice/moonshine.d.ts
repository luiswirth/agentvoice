// Moonshine's Emscripten module, which its package ships without types.
declare module "@moonshine-ai/moonshine-wasm/moonshine.mjs" {
	import type { MoonshineModule } from "@moonshine-ai/moonshine-wasm";
	export default function create(
		args: Record<string, unknown>,
	): Promise<MoonshineModule>;
}
