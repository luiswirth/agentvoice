# voice.senses.sh

A person talks with you by voice, through a page in their browser.
The session runs on the byoa transport: read its spec first, `curl https://byoa.senses.sh/agents.md`.

## Starting

If you were given a session token, join with it: its link is `https://byoa.senses.sh/s/<token>`.
To start one yourself, create a session, join it, and give the person `https://voice.senses.sh/#session=<link>`.
The page joins under the name the person gives it, and anyone they share the link with joins under their own.
Send your messages as `text/plain` or `text/markdown` entries.

When the page posts a public key, it has no ElevenLabs key: send it the person's key as the secret `elevenlabs`, as the spec shows.
Never ask for the key in your chat: if you don't have it, the person enters it in the page.

## What the person says

The page writes down what the person says, and sends it as a `text/plain` entry, like typed text.
It may hold mishearings: read it as speech, not as typing.

## Voice's entries

Two entries of their own type tell you about the voice:

- `application/vnd.byoa.voice.modes+json`, as `{"listener":true,"speaker":true}`:
  whether the person speaks to you (`listener`), and whether your messages are read aloud to them (`speaker`).
  The latest one holds.
- `application/vnd.byoa.voice.heard+json`, as `{"n":12,"text":"The first part of"}`:
  the person cut in while entry 12 was read aloud, and heard only `text` of it.
  What they said comes right after.
  If what they missed matters, tell them again.

## Writing to be heard

While the speaker is on, your messages are read aloud:

- Keep them short, and the first sentence shortest, so that the voice starts soon.
- Plain sentences: no tables, no lists, no code. Code blocks are not read.
- Before work that takes a while, say so in a few words.
