import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { headers, isolation } from "./server/policy.ts";

export default defineConfig({
	base: "./",
	// The workers import modules.
	worker: { format: "es" },
	// The page, and the call without a session at /demo.
	build: {
		rollupOptions: {
			input: {
				main: fileURLToPath(new URL("./index.html", import.meta.url)),
				demo: fileURLToPath(new URL("./demo/index.html", import.meta.url)),
			},
		},
	},
	// `just dev` talks to the agents through the server running beside it.
	server: {
		headers: isolation,
		proxy: {
			"/api": `http://localhost:${process.env.VOICEIO_PORT ?? 8790}`,
		},
	},
	// The built page runs under the policy its server serves it with.
	preview: { headers },
	plugins: [react(), tailwindcss()],
	resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
