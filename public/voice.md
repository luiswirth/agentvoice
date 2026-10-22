# Voice

Voice is an extension of speech, whose spec is `https://byoa.senses.sh/speech.md`:
a person talks and listens, instead of typing and reading.

## What the person says

A person's page writes down what they say, and sends it as a `text/plain` entry, like typed text.
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
