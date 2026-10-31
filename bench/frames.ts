// How smoothly the page runs in a state of bench/gallery-page.tsx, on an
// iPhone-sized page with the CPU slowed 6x, as a phone's is: frames in 4 s,
// and where the time went.
//
//   just frames [state]
import { chromium } from "playwright-core";
import { createServer } from "vite";

const server = await createServer({ server: { port: 0 }, logLevel: "silent" });
await server.listen();
const url = server.resolvedUrls?.local[0];
const browser = await chromium.launch({
	executablePath: process.env.CHROMIUM ?? "",
});
try {
	const context = await browser.newContext({
		viewport: { width: 390, height: 760 },
		deviceScaleFactor: 3,
	});
	const tab = await context.newPage();
	await tab.goto(
		`${url}bench/gallery.html?state=${process.argv[2] ?? "agent-speaking"}`,
	);
	await tab.waitForTimeout(1500);
	const cdp = await context.newCDPSession(tab);
	await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
	await cdp.send("Performance.enable");
	const metrics = async () =>
		Object.fromEntries(
			(await cdp.send("Performance.getMetrics")).metrics.map((m) => [
				m.name,
				m.value,
			]),
		);
	const before = await metrics();
	const gaps: number[] = await tab.evaluate(`new Promise((done) => {
		const gaps = [];
		let last = performance.now();
		const end = last + 4000;
		const tick = (now) => {
			gaps.push(now - last);
			last = now;
			if (now < end) requestAnimationFrame(tick);
			else done(gaps);
		};
		requestAnimationFrame(tick);
	})`);
	const after = await metrics();
	console.log(
		["ScriptDuration", "RecalcStyleDuration", "LayoutDuration", "TaskDuration"]
			.map(
				(k) =>
					`${k} ${(((after[k] ?? 0) - (before[k] ?? 0)) * 1000).toFixed(0)}ms`,
			)
			.join(", "),
	);
	gaps.sort((a, b) => a - b);
	const q = (p: number) => gaps[Math.floor(p * (gaps.length - 1))]?.toFixed(1);
	console.log(
		`frames ${gaps.length} in 4 s; median ${q(0.5)} ms, p90 ${q(0.9)} ms, max ${q(1)} ms`,
	);
} finally {
	await browser.close();
	await server.close();
}
