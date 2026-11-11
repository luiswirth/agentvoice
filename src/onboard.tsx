/** The page a person meets first: one prompt to give their agent, which does
 * everything else. Styled with Tailwind and shadcn's theme variables. */

import { type ReactNode, useState } from "react";

export type OnboardProps = {
	/** The service, as the person knows it, such as `agentvoice.lwirth.com`.
	 * Without one, the page sits inside a site of its own, which already
	 * names the service: see `Frame`. */
	name?: string;
	/** What the person gets, in a few words. */
	title: string;
	/** One or two sentences on it. */
	description: string;
	/** The session's link, which names its relay. The page offers it on its
	 * own, and in the prompt that points the agent at the service's page for
	 * agents, as its token alone where it is on the default relay. */
	link: string;
	/** What the agent is to do once it has joined, such as `set up voice so we
	 * can talk`: without it, agents read the prompt as only joining. */
	goal?: string;
	/** Ways to set the service up that the person chooses between before the
	 * prompt, such as where voice runs. The chosen one's goal replaces `goal`,
	 * and no prompt shows until one is chosen. */
	choice?: Choice;
	/** The person's name, under which the prompt names their agent, as
	 * `<person>/<agent>`. */
	person?: string;
	/** The service's page for agents, which the prompt points at: by default
	 * `agents.md` beside the page. */
	agents?: string;
	/** Whether the page goes on once the agent has joined, so that the person
	 * keeps it open: by default it does. */
	follows?: boolean;
	/** What the person should know before, such as an account it needs. */
	note?: ReactNode;
	/** What follows the prompt on the service's side, such as the agent's
	 * steps once it joined, shown under it on the same page: copying the
	 * prompt only copies it, and the page changes in place. */
	children?: ReactNode;
};

export type Choice = {
	options: Option[];
	/** The option chosen, by its `id`, null for none yet. */
	chosen: string | null;
	choose(id: string): void;
	/** Whether the choice is settled, such as once the agent joined: the
	 * options fold away, and the chosen one's detail and prompt stay. */
	folded?: boolean;
};

export type Option = {
	id: string;
	/** Its name, in a word or two. */
	title: string;
	/** What it is, in one short sentence. */
	description: string;
	/** What it costs or needs, in a few words each, such as `Free`. */
	facts?: string[];
	/** What the agent is to do once it has joined, as `goal`. */
	goal: string;
	/** What the person can do here once it is chosen, such as entering a key,
	 * shown under the options, before the prompt. */
	detail?: ReactNode;
};

const NAME = "agentvoice-name";

/** What the person types, in the form of a name as it is typed: lower case,
 * with hyphens for spaces, as `luis-wirth`, and only the letters a to z,
 * digits and hyphens, starting with a letter or digit, as agentwire takes
 * names. An accent goes from its letter, as `müller` becomes `muller`; a
 * slash goes, since it divides an agent's name from its person's. */
function nameForm(typed: string): string {
	return typed
		.toLowerCase()
		.normalize("NFD")
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/^-+/, "");
}

/** The name stored in this browser, in the form of a name: one stored
 * before names took it, such as `Luis Wirth`, is stored again as
 * `luis-wirth`. */
function storedName(): string | null {
	const stored = localStorage.getItem(NAME);
	if (stored === null) return null;
	const name = nameForm(stored).replace(/^-+|-+$/g, "");
	if (!name) {
		localStorage.removeItem(NAME);
		return null;
	}
	if (name !== stored) localStorage.setItem(NAME, name);
	return name;
}

/** Asks the person for the name they take part under, once per browser, and
 * renders the page under it, with `rename` to ask again, such as for a name
 * that is taken in the session. Every person in a session has a name of
 * their own, as every agent has. */
export function Named({
	service,
	children,
}: {
	/** The service, as the person knows it, such as `agentvoice.lwirth.com`. */
	service: string;
	children: (name: string, rename: () => void) => ReactNode;
}) {
	const [name, setName] = useState(storedName);
	const [draft, setDraft] = useState("");
	if (name)
		return children(name, () => {
			localStorage.removeItem(NAME);
			setDraft(name);
			setName(null);
		});
	const chosen = draft.replace(/^-+|-+$/g, "");
	return (
		<Frame
			name={service}
			title="What's your name?"
			description="Everyone in the session, people and agents, sees you under it."
		>
			<form
				className="flex flex-col gap-2 rounded-2xl border bg-card/60 p-2 shadow-2xl shadow-black/20 backdrop-blur sm:flex-row"
				onSubmit={(event) => {
					event.preventDefault();
					if (!chosen) return;
					localStorage.setItem(NAME, chosen);
					setName(chosen);
				}}
			>
				<input
					// biome-ignore lint/a11y/noAutofocus: the one thing on the page
					autoFocus
					className="h-11 flex-1 rounded-xl bg-background/80 px-4 text-base outline-none placeholder:text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
					placeholder="Your name"
					maxLength={64}
					value={draft}
					onChange={(event) => setDraft(nameForm(event.target.value))}
				/>
				<button
					type="submit"
					disabled={!chosen}
					className="h-11 rounded-xl bg-primary px-6 font-medium text-primary-foreground transition-all outline-none hover:bg-primary/85 focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px disabled:opacity-50"
				>
					Continue
				</button>
			</form>
		</Frame>
	);
}

/** The look every page of a person's onboarding shares, for a service's own
 * steps too. With `name`, it is the whole page: the service's name above, a
 * glow, and a footer. Without one, it sits inside a site's own header and
 * footer, which already name the service. */
export function Frame({
	name,
	title,
	description,
	children,
}: {
	name?: string | undefined;
	title: string;
	description: string;
	children: ReactNode;
}) {
	const body = (
		<div className="relative flex w-full max-w-xl flex-col gap-10">
			<header className="flex flex-col gap-4">
				{name && (
					<span className="font-mono text-sm text-muted-foreground">
						{name}
					</span>
				)}
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
	if (!name)
		return (
			<div className="flex justify-center px-6 pt-12 md:pt-20">{body}</div>
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

/** The default relay, which every service's page for agents names, so that a
 * session's token alone means a session on it. */
export const defaultRelay = "https://agentwire.agentics.lwirth.com";

/** What names the session at `link` for an agent: its token alone where it is
 * on the default relay, and its full link on any other. */
function sessionOf(link: string) {
	const token = link.slice(`${defaultRelay}/v2/s/`.length);
	return link === `${defaultRelay}/v2/s/${token}` && /^[\w-]+$/.test(token)
		? token
		: link;
}

/** The prompt that brings an agent into the session at `link`: to read the
 * service's page for agents, join under the person's prefix, and do `goal`.
 * It holds one link, to the page for agents, and names the session by
 * `sessionOf`. */
function promptFor(
	link: string,
	agents: string,
	person?: string,
	goal?: string,
) {
	const as = person ? ` as ${person}/<agent>` : "";
	const then = goal ? `, and ${goal}` : "";
	return `Read ${agents} and join the session ${sessionOf(link)}${as}${then}.`;
}

export function Onboard({
	name,
	title,
	description,
	link,
	goal,
	choice,
	person,
	agents = new URL("agents.md", document.baseURI).href,
	follows = true,
	note,
	children,
}: OnboardProps) {
	const chosen = choice?.options.find((option) => option.id === choice.chosen);
	const prompt = promptFor(link, agents, person, chosen ? chosen.goal : goal);
	return (
		<Frame name={name} title={title} description={description}>
			{choice && <Options choice={choice} />}
			{chosen?.detail}
			{(!choice || chosen) && (
				<section className="flex flex-col gap-3">
					<div className="flex flex-col gap-2 rounded-2xl border bg-card/60 p-2 shadow-2xl shadow-black/20 backdrop-blur">
						<pre className="rounded-xl bg-background/80 p-4 font-mono text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">
							{prompt}
						</pre>
						<Copy
							text={prompt}
							label="Copy the prompt for your agent"
							primary
						/>
					</div>
					<p className="px-2 text-sm text-pretty text-muted-foreground">
						{follows
							? "Paste it into your agent, such as Claude Code, and keep this page open: it goes on once your agent has joined."
							: "Paste it into your agent, such as Claude Code."}{" "}
						<CopyLink link={link} />
					</p>
					<p className="px-2 text-sm text-pretty text-muted-foreground">
						The session's {sessionOf(link) === link ? "link" : "token"} is like
						a password: share it only with people you trust.
					</p>
				</section>
			)}
			{children}
			{note && <p className="text-sm text-muted-foreground">{note}</p>}
		</Frame>
	);
}

/** The ways to set the service up, as large buttons side by side, which
 * fold away in place once the choice is settled, so that nothing below jumps. */
function Options({ choice }: { choice: Choice }) {
	const folded = choice.folded ?? false;
	return (
		<div
			inert={folded}
			className={`grid transition-all duration-500 ease-out ${folded ? "-mb-10 grid-rows-[0fr] opacity-0" : "grid-rows-[1fr]"}`}
		>
			<fieldset
				className={`grid min-h-0 gap-3 sm:grid-cols-2 ${folded ? "overflow-hidden" : ""}`}
			>
				{choice.options.map((option) => {
					const on = option.id === choice.chosen;
					return (
						<label
							key={option.id}
							className={`flex cursor-pointer flex-col gap-2 rounded-2xl border p-5 transition-all has-focus-visible:ring-3 has-focus-visible:ring-ring/50 active:translate-y-px ${on ? "border-primary/70 bg-card shadow-2xl shadow-black/30 ring-1 ring-primary/40" : "bg-card/40 hover:border-foreground/30 hover:bg-card/70"}`}
						>
							<input
								type="radio"
								name="onboard-choice"
								className="sr-only"
								checked={on}
								onChange={() => choice.choose(option.id)}
							/>
							<span className="flex items-center justify-between gap-3">
								<span className="text-xl font-semibold tracking-tight">
									{option.title}
								</span>
								<span
									aria-hidden
									className={`flex size-5 shrink-0 items-center justify-center rounded-full border transition ${on ? "border-primary bg-primary" : "border-muted-foreground/40"}`}
								>
									{on && (
										<span className="size-2 rounded-full bg-primary-foreground" />
									)}
								</span>
							</span>
							<span className="text-sm text-pretty text-muted-foreground">
								{option.description}
							</span>
							{option.facts && (
								<span className="mt-1 flex flex-wrap gap-1.5">
									{option.facts.map((fact) => (
										<span
											key={fact}
											className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
										>
											{fact}
										</span>
									))}
								</span>
							)}
						</label>
					);
				})}
			</fieldset>
		</div>
	);
}

/** The session alone, as the prompt names it, for an agent that is given it
 * some other way, such as an adapter's command. */
function CopyLink({ link }: { link: string }) {
	const [copied, setCopied] = useState(false);
	const session = sessionOf(link);
	const what = session === link ? "link" : "token";
	return (
		<button
			type="button"
			title={session}
			className="text-foreground/80 underline underline-offset-4 hover:text-foreground"
			onClick={async () => {
				await navigator.clipboard.writeText(session);
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			}}
		>
			{copied
				? `${what === "link" ? "Link" : "Token"} copied`
				: `Copy the session's ${what} alone`}
		</button>
	);
}

function Copy({
	text,
	label,
	primary = false,
}: {
	text: string;
	label: string;
	primary?: boolean;
}) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			className={`flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl px-4 font-medium transition-all outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px ${primary ? "bg-primary text-primary-foreground hover:bg-primary/85" : "border bg-background/80 hover:bg-muted"}`}
			onClick={async () => {
				await navigator.clipboard.writeText(text);
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			}}
		>
			<svg
				aria-hidden
				viewBox="0 0 24 24"
				className="size-4"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				{copied ? (
					<path d="M20 6 9 17l-5-5" />
				) : (
					<>
						<rect width="14" height="14" x="8" y="8" rx="2" />
						<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
					</>
				)}
			</svg>
			{copied ? "Copied" : label}
		</button>
	);
}
