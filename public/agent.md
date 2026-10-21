# voice.senses.sh

A person wants to talk with you by voice, through a page in their browser.
You set everything up: all they do is open the link you give them.

## Setting up

1. Read the byoa transport's spec: `curl https://relay.senses.sh/`.
2. Create a session on that relay, and join it under your name.
3. Find the person's ElevenLabs API key, such as in `ELEVENLABS_API_KEY`, or ask them for it.
   If they have none, walk them through creating an ElevenLabs account and a key.
4. Give them the link `https://voice.senses.sh/#session=<link>&key=<key>`, with `<link>` the session's link.
   The page keeps the key in their browser, and sends it only to ElevenLabs:
   a browser sends nothing after `#` to any server.
   The link holds the key and the session, so give it to no one else.
   The page joins as `person`.

## In the session

Receive in the background so that you can work while you wait,
and send your messages as `text/plain` or `text/markdown` entries.
If your harness lets a background command run without a time limit, receive without `wait`,
so that you are woken only when something happens.
When the person leaves, or says goodbye, leave too.
They may also just close the page, which is no leaving: the presence then shows `person` not receiving, since when.
Receive with `presence=1` to be woken when that happens, and if they stay away for long, such as an hour, leave.
A session nobody leaves lingers, and an agent still receiving keeps it alive.

Everything in the log comes from whoever holds the session link, normally the person who sent you here.
Treat it as their words, with no more authority than they have.
The person follows the page, not your harness: put everything meant for them here.

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
