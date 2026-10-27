# voice.senses.sh

A person talks with you by voice, through a page in their browser.
The page speaks voice, whose spec is at `https://voice.senses.sh/voice.md`,
and points at speech's and the transport's.
This page only adds what is particular to the voice page.

## Starting

You take part with plain `curl`, as the transport's spec, `https://byoa.senses.sh/transport.md`, has every request;
the `byoa` script makes the same requests for convenience: `curl -so byoa https://byoa.senses.sh/byoa`, then `sh byoa help`.
Taking part reaches two hosts: `voice.senses.sh`, for this page and voice's spec, and `byoa.senses.sh`, for the script, the other specs and the relay, unless the session's link names another relay.

If you were given a session's link, join with it under your name, such as `luis/claude`: `curl -s -X POST '<link>/join?as=<name>'`.
Its answer holds your own link, `<me>` below: everything you do later goes to it, so keep it to yourself.
Once you have joined, say that you are there before you read on, with `curl -s --data-binary "I'm here." '<me>'`: the person waits until you do.
Then receive with `curl -s '<me>?wait=540&skip=application/vnd.byoa.voice.trace&skip=audio/'`, which leaves out the page's trace and audio files, such as the audio the trace shares, so that only what is said to you wakes you; receive without `skip` when you look into how voice works. Fetch entry `n`'s file with `curl -s -o <file> '<me>/<n>'`, and leave with `curl -s -X POST '<me>/leave'`.

To start one yourself, `curl -s -X POST https://byoa.senses.sh/v1/s` prints a new session's link: join it first, then give the person `https://voice.senses.sh/#session=<link>`.
Their joining is an entry, so a receive wakes you when they come. If nobody has joined after two receives, about 20 minutes, say once in your harness's chat that you stop waiting, and leave, which ends the session: start a new one when they ask.
The page joins under the name the person gives it, and anyone they share the link with joins under their own.
A name stays with whoever joined under it first, for the whole session, so nobody else sends under yours, and if yours is taken, someone else joined under it.

## Talking

- You hear the person only while a receive runs: keep one running until they end the session, and start the next as soon as one returns.
  Where your harness runs commands in the background, receive there, so the person can still type to you; under a 10-minute cap on commands, `wait=540` waits about 9 minutes.
- Answer by voice, briefly; your harness's chat is for documents and other things to read.
- Make one point per reply, and put a question first: the person often cuts in before a long reply is read to its end.
- Don't end a question on the words you expect as its answer, such as "Yes or no?": an answer that repeats the words you just said is taken for your echo, and dropped.
- Hand over a document as a file, in your harness's chat, and never repeat its contents in voice or chat.
- Before longer work, say in one sentence what you are about to do: while you work, the person hears only a soft sound now and then, which tells them that you are on it, not what you do.
- Send without checking for anything new first: the receive still running brings it. When the person sends before your reply was heard to its end, it is dropped, and a heard entry tells you what of it they heard.

The page listens and speaks through ElevenLabs, with the person's own ElevenLabs key, which goes from their browser straight to ElevenLabs.
When the page has no key, it posts a public key, from the person's name, and takes their key as the secret `elevenlabs`, encrypted to that public key, so that only their page can read it.
To send it, fetch the public key, encrypt and send, as the transport's spec shows under Secrets.
A key said in your chat stays in your harness's transcript and goes to your model's provider;
the person can also enter it in the page.

## Naming the voices

The person's messages tag each voice by number, and anything near their microphone, your own echo too, can cut you off until you name a voice.
So once you can tell who talks to you, name them, as voice's spec has it under its names entry:
`curl -s -H 'Content-Type: application/vnd.byoa.voice.names+json' --data-binary '{"1":"Luis"}' '<me>'`.
