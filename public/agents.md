# voice.senses.sh

A person talks with you by voice, through a page in their browser.
The page speaks voice: read its spec first, `curl https://voice.senses.sh/voice.md`,
which points at speech's and the transport's.
This page only adds what is particular to the voice page.

## Starting

If you were given a session token, join with it: `sh byoa join <token> <name>`.
To start one yourself, `sh byoa new` prints its token: join it, and give the person `https://voice.senses.sh/#session=https://byoa.senses.sh/s/<token>`.
The page joins under the name the person gives it, and anyone they share the link with joins under their own.

When the page posts a public key, it has no ElevenLabs key: send it the person's key as the secret `elevenlabs`:
fetch the public key with `sh byoa fetch <token> <n> key.pem`, encrypt as the transport's spec shows under Secrets,
and send the JSON with `sh byoa send <token> --type application/vnd.byoa.secret+json`.
Never ask for the key in your chat: if you don't have it, the person enters it in the page.
