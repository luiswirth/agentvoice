/** The frame of the page's steps before the call. Styled with Tailwind and
 * shadcn's theme variables. */

import type { ReactNode } from "react";

/** The look of every page but the call's: the service's name above, a
 * title and a description, and a glow. */
export function Frame({
	name,
	title,
	description,
	children,
}: {
	name: string;
	title: string;
	description: string;
	children: ReactNode;
}) {
	const body = (
		<div className="relative flex w-full max-w-xl flex-col gap-10">
			<header className="flex flex-col gap-4">
				<span className="font-mono text-sm text-muted-foreground">{name}</span>
				<h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
					{title}
				</h1>
				<p className="text-lg text-pretty text-muted-foreground">
					{description}
				</p>
			</header>
			{children}
		</div>
	);
	return (
		<div className="relative flex min-h-dvh items-center justify-center overflow-hidden px-6 py-16">
			<div
				aria-hidden
				className="pointer-events-none absolute inset-0"
				style={{
					background:
						"radial-gradient(60rem 30rem at 50% -10%, var(--onboard-glow, oklch(0.6 0.17 265 / 0.22)), transparent 70%)",
				}}
			/>
			{body}
		</div>
	);
}
