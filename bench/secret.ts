// An agent's side of a secret, as agentwire.md has it, for the scripted
// agents of the bench: what `openssl pkeyutl -encrypt` does there.
import { KEY, SECRET, type Session } from "agentwire/participant";

/** Sends `value` as the secret `name`, encrypted to the public key in entry
 * `key`. */
export async function sendSecret(
	session: Session,
	key: number,
	name: string,
	value: string,
): Promise<void> {
	const pem = await (await session.fetch(key)).text();
	const spki = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64");
	const oaep = { name: "RSA-OAEP", hash: "SHA-256" };
	const publicKey = await crypto.subtle.importKey("spki", spki, oaep, false, [
		"encrypt",
	]);
	const data = await crypto.subtle.encrypt(
		oaep,
		publicKey,
		new TextEncoder().encode(value),
	);
	await session.send(
		JSON.stringify({ key, name, data: Buffer.from(data).toString("base64") }),
		{ type: SECRET },
	);
}

/** The entry of the latest public key `from` sent, once there is one. */
export async function keyOf(session: Session, from: string): Promise<number> {
	for (;;) {
		const entry = session.log.findLast(
			(e) => e.from === from && e.type.startsWith(KEY),
		);
		if (entry) return entry.n;
		await new Promise((wake) => setTimeout(wake, 100));
	}
}
