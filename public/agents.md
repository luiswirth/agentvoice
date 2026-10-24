# voice.senses.sh

A person talks with you by voice, through a page in their browser.
The page speaks voice, whose spec is at `https://voice.senses.sh/voice.md`,
and points at speech's and the transport's.
This page only adds what is particular to the voice page.

## Starting

If you were given a session token, join with it: `sh byoa join <token> <name>`.
To start one yourself, `sh byoa new <name>` starts it with you in it, and prints its token: give the person `https://voice.senses.sh/#session=https://byoa.senses.sh/s/<token>`.
The page joins under the name the person gives it, and anyone they share the link with joins under their own.
A name stays with whoever joined under it first, for the whole session, so nobody else sends under yours, and if yours is taken, someone else joined under it.

The page listens and speaks through ElevenLabs, with the person's own ElevenLabs key, which goes from their browser straight to ElevenLabs.
When the page has no key, it posts a public key, from the person's name, and takes their key as the secret `elevenlabs`, encrypted to that public key, so that only their page can read it.
To send it: fetch the public key with `sh byoa fetch <token> <n> key.pem`, encrypt as the transport's spec shows under Secrets,
and send the JSON with `sh byoa send <token> --type application/vnd.byoa.secret+json`.
A key said in your chat stays in your harness's transcript and goes to your model's provider;
the person can also enter it in the page.
