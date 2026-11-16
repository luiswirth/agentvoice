/** Vibe Together, the page's transport, through its client library's
 * WebAssembly build in `src/vt` (`just client`). The page is the person by a
 * person token, which they approve on Vibe Together as an OTP, and which stays
 * in this browser. */

import init, {
	Client,
	type Entry,
	type Overview,
	type Participant,
	type Session,
} from "./vt/vibetogether_client.js";

export type { Entry, Overview, Participant, Session };

/** Where the page reaches Vibe Together's API: its own origin, whose `/api/`
 * goes to Vibe Together's backend, as dotcloud's serve.nix has it, and as
 * vite.config.ts has it while developing. */
const server = location.origin;

const TOKEN = "vibetogether-token";

const ready = init();

function stored(): string | null {
	try {
		return localStorage.getItem(TOKEN);
	} catch {
		return null;
	}
}

let current: { token: string; client: Client } | null = null;

/** The client of the person signed in, or none. */
export async function client(): Promise<Client | null> {
	await ready;
	const token = stored();
	if (token === null) return null;
	if (current?.token !== token)
		current = { token, client: new Client(server, token) };
	return current.client;
}

/** The client of the person signed in, which a call needs. */
export async function signedIn(): Promise<Client> {
	const c = await client();
	if (c === null) throw new SignedOut();
	return c;
}

export class SignedOut extends Error {
	constructor() {
		super("Sign in to Vibe Together.");
	}
}

/** Whether a call was refused for want of a valid token, such as one the
 * person revoked: the page then forgets it. */
export function refusedToken(error: unknown): boolean {
	if (error instanceof SignedOut) return true;
	if ((error as { status?: unknown } | null)?.status !== 401) return false;
	forget();
	return true;
}

/** Whether a call was refused, rather than failed on the way. */
export function refused(error: unknown): boolean {
	const status = (error as { status?: unknown } | null)?.status;
	return typeof status === "number" && status < 500;
}

function forget() {
	try {
		localStorage.removeItem(TOKEN);
	} catch {}
	current = null;
}

/** Asks Vibe Together for a person token: `approve` gets the link where the
 * person approves it, and the promise its token, kept in this browser, once
 * they did. */
export async function signIn(
	approve: (link: string) => void,
	signal: AbortSignal,
): Promise<void> {
	await ready;
	const anonymous = new Client(server, null);
	const otp = await anonymous.requestOtp({
		kind: "person",
		name: "agentvoice",
	});
	approve(otp.link);
	const { token, kind } = await anonymous.redeemOtp(otp.secret, signal);
	if (kind !== "person") throw new Error("Vibe Together gave no person token.");
	localStorage.setItem(TOKEN, token);
}

/** Signs out: revokes the page's token, so that it is gone on Vibe Together
 * too, and forgets it. */
export async function signOut(): Promise<void> {
	try {
		const c = await client();
		const login = (await c?.logins())?.find((login) => login.current);
		if (c && login) await c.revokeLogin(login.id);
	} catch {}
	forget();
}

/** Every session the person can talk in, by group: each group's general
 * first, its own sessions, then its projects', and then the DMs. */
export function sessionsOf(overview: Overview): Session[] {
	return [
		...overview.groups.flatMap((group) => [
			...group.sessions,
			...group.projects.flatMap((project) => project.sessions),
		]),
		...overview.dms,
	];
}
