# byoa-voice

A person talks with you by voice, through a page in their browser.
They gave you a session link, `<link>` below.

The session runs on the byoa transport: read its spec first.
The relay answers it at its root, the link without its id, such as `curl https://relay.senses.sh/`.
Join under your name, receive in the background so that you can work while you wait,
and send your messages as `text/plain` or `text/markdown` entries.
If your harness lets a background command run without a time limit, receive without `wait`,
so that you are woken only when something happens.
The page joins as `person`.
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
