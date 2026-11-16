/** Vibe Together, the page's transport, through its client library's
 * WebAssembly build in `src/vt` (`just client`). The page is an app of Vibe
 * Together's: the person approves its OTP there, and its app token, which
 * only sends and reads in their sessions, stays in this browser. Its messages
 * say they came through agentvoice. */

import init, {
	Client,
	type Entry,
	type Participant,
	type Session,
} from "./vt/vibetogether_client.js";

export type { Entry, Participant, Session };

/** Vibe Together's backend, which answers any origin's calls with a token:
 * `VITE_VIBETOGETHER` at build time names another, such as a local one. */
export const server: string =
	import.meta.env.VITE_VIBETOGETHER ??
	"https://vibetogether.potentialhedge.com";

/** The app's name, which the person approves and its messages carry. */
const APP = "agentvoice";

/** Where the token is kept, with its login's id, which signing out revokes. */
const TOKEN = "vibetogether-token";
const LOGIN = "vibetogether-login";

const ready = init();

function stored(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

let current: { token: string; client: Client } | null = null;

/** The client of the person signed in, or none. */
export async function client(): Promise<Client | null> {
	await ready;
	const token = stored(TOKEN);
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

const status = (error: unknown) =>
	(error as { status?: unknown } | null)?.status;

/** Whether a call was refused for want of a valid token, such as one the
 * person revoked: the page then forgets it. */
export function refusedToken(error: unknown): boolean {
	if (error instanceof SignedOut) return true;
	if (status(error) !== 401) return false;
	forget();
	return true;
}

/** Whether a call was refused, rather than failed on the way. */
export function refused(error: unknown): boolean {
	const s = status(error);
	return typeof s === "number" && s < 500;
}

function forget() {
	try {
		localStorage.removeItem(TOKEN);
		localStorage.removeItem(LOGIN);
	} catch {}
	current = null;
}

/** Asks Vibe Together for an app token: `approve` gets the link where the
 * person approves it, and the promise ends once they did, the token kept in
 * this browser. */
export async function signIn(
	approve: (link: string) => void,
	signal: AbortSignal,
): Promise<void> {
	await ready;
	const anonymous = new Client(server, null);
	const otp = await anonymous.requestOtp({ kind: "app", name: APP });
	approve(otp.link);
	const { token, kind, login } = await anonymous.redeemOtp(otp.secret, signal);
	if (kind !== "app") throw new Error("Vibe Together gave no app token.");
	localStorage.setItem(TOKEN, token);
	localStorage.setItem(LOGIN, login);
}

/** Signs out: revokes the page's token on Vibe Together, and only then, or
 * where it is gone already, forgets it. */
export async function signOut(): Promise<void> {
	const c = await client();
	const login = stored(LOGIN);
	if (c && login) {
		try {
			await c.revokeLogin(login);
		} catch (error) {
			if (status(error) !== 401 && status(error) !== 404)
				throw new Error(
					`Vibe Together didn't revoke this page's sign-in (${(error as Error).message}): revoke "agentvoice" under Logins in your settings there.`,
				);
		}
	}
	forget();
}

/** Every session the person can talk in, by group: each group's general
 * first, then its own and its projects' sessions, and then the DMs. */
export async function sessions(): Promise<Session[]> {
	const c = await signedIn();
	const [mine, dms] = await Promise.all([c.sessions(), c.dms()]);
	const groups = Map.groupBy(mine, (session) => session.group?.id ?? "");
	return [
		...[...groups.values()].flatMap((sessions) =>
			sessions.toSorted((a, b) => Number(b.general) - Number(a.general)),
		),
		...dms,
	];
}
