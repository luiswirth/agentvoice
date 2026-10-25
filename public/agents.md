# voice.senses.sh

A person talks with you by voice, through a page in their browser.
The page speaks voice, whose spec is at `https://voice.senses.sh/voice.md`,
and points at speech's and the transport's.
This page only adds what is particular to the voice page.

## Starting

The `byoa` script takes part from a shell: `curl -so byoa https://byoa.senses.sh/byoa`, then `sh byoa help`.
If you were given a session's link, join with it: `sh byoa join <link> <name>`.
Once you have joined, say that you are there before you read on: the person waits until you do.
To start one yourself, `sh byoa new <name>` starts it with you in it, and prints its link: give the person `https://voice.senses.sh/#session=<link>`.
The page joins under the name the person gives it, and anyone they share the link with joins under their own.
A name stays with whoever joined under it first, for the whole session, so nobody else sends under yours, and if yours is taken, someone else joined under it.

## Talking

- You hear the person only while a receive runs: keep one running until they end the session, and start the next as soon as one returns.
  Where your harness runs commands in the background, receive there, so the person can still type to you; under a 10-minute cap on commands, `--wait 540` waits about 9 minutes.
- Answer by voice, briefly; your harness's chat is for documents and other things to read.
- Hand over a document as a file, in your harness's chat, and never repeat its contents in voice or chat.
- Before longer work, say in one sentence what you are about to do: while you work, the person hears nothing.
- Right before you send, check for anything new with `sh byoa receive <link> --wait 0`, and take it into your reply; it ends a receive still running, so start that again after.

The page listens and speaks through ElevenLabs, with the person's own ElevenLabs key, which goes from their browser straight to ElevenLabs.
When the page has no key, it posts a public key, from the person's name, and takes their key as the secret `elevenlabs`, encrypted to that public key, so that only their page can read it.
To send it: fetch the public key with `sh byoa fetch <link> <n> key.pem`, encrypt as the transport's spec shows under Secrets,
and send the JSON with `sh byoa send <link> --type application/vnd.byoa.secret+json`.
A key said in your chat stays in your harness's transcript and goes to your model's provider;
the person can also enter it in the page.

## Naming the voices

The person's messages tag each voice by number, and anything near their microphone, your own echo too, can cut you off until you name a voice.
So once you can tell who talks to you, name them, as voice's spec has it under its names entry:
`echo '{"1":"Luis"}' | sh byoa send <link> --type application/vnd.byoa.voice.names+json`.
