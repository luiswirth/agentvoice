// Signs the bench in to Vibe Together as the person, through the page's own
// sign-in, in Chromium: prints the link to approve, and keeps the page's
// token in .cache for `just bench`, readable only by its owner.
//
//   just token
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium } from "playwright-core";
import { preview } from "vite";
import { TOKEN } from "./vt.ts";

const server = await preview({ preview: { port: 0 }, logLevel: "silent" });
const browser = await chromium.launch({
	executablePath: process.env.CHROMIUM ?? "",
});
try {
	const tab = await browser.newPage();
	await tab.goto(server.resolvedUrls?.local[0] ?? "");
	const link = tab.getByRole("link", { name: "Sign in with Vibe Together" });
	await tab.waitForFunction(
		() => document.querySelector("a[href*='/account/otp/']") !== null,
	);
	console.log(
		`Approve the bench's sign-in: ${await link.getAttribute("href")}`,
	);
	const token = await tab.waitForFunction(
		() => localStorage.getItem("vibetogether-token"),
		null,
		{ timeout: 15 * 60_000, polling: 1000 },
	);
	await mkdir(dirname(TOKEN), { recursive: true });
	await writeFile(TOKEN, String(await token.jsonValue()), { mode: 0o600 });
	await chmod(TOKEN, 0o600);
	// The page goes on to the sessions, which only a valid token lists.
	await tab.getByText("Pick a session").waitFor();
	console.log(`signed in: ${TOKEN}`);
} finally {
	await browser.close();
	await server.close();
}
