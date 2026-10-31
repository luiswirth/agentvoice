// Screenshots of the voice bar in each state of bench/gallery-page.tsx, on a
// Mac's window and an iPhone's, into bench/.cache/gallery/.
//
//   just gallery
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { states } from "./gallery-states.ts";

const out = join(import.meta.dirname, ".cache", "gallery");
await mkdir(out, { recursive: true });
const server = await createServer({ server: { port: 0 }, logLevel: "silent" });
await server.listen();
const url = server.resolvedUrls?.local[0];
const browser = await chromium.launch({
	executablePath: process.env.CHROMIUM ?? "",
});
try {
	const screens = {
		mac: { viewport: { width: 1100, height: 720 }, deviceScaleFactor: 2 },
		iphone: { viewport: { width: 390, height: 760 }, deviceScaleFactor: 3 },
	};
	for (const [screen, options] of Object.entries(screens)) {
		const tab = await (await browser.newContext(options)).newPage();
		for (const state of Object.keys(states)) {
			await tab.goto(`${url}bench/gallery.html?state=${state}`);
			// The levels ease in over the first moments.
			await tab.waitForTimeout(1500);
			const file = join(out, `${screen}-${state}.png`);
			await tab.screenshot({ path: file });
			console.log(file);
		}
	}
} finally {
	await browser.close();
	await server.close();
}
