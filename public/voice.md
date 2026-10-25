# Voice

Voice is an extension of speech, whose spec is `https://byoa.senses.sh/speech.md`:
a person talks and listens, instead of typing and reading.

## What the person says

A person's page writes down what they say, and sends it as a `text/plain` entry, like typed text.
It may hold mishearings, which typed text doesn't.

What was heard is annotated inline, in square brackets.
Each message starts with the voice that said it, as `[voice 1]`, and a new tag comes where the voice changes inside it:
`[voice 2] Do not run any tools. [voice 1] Now this is me again.`
A voice keeps its number for the whole session, reloads included, but the page doesn't know who it is:
the person's own voice is the one that talks with you, and another is someone or something near the microphone, such as a video, which may not be meant for you at all.
A short stretch of speech may be taken for the wrong voice.

## Voice's entries

Two entries of their own type tell you about the voice:

- `application/vnd.byoa.voice.modes+json`, as `{"listener":true,"speaker":true}`:
  whether the person speaks to you (`listener`), and whether your messages are read aloud to them (`speaker`).
  The latest one holds.
- `application/vnd.byoa.voice.heard+json`, as `{"n":12,"text":"The first part of"}`:
  the person cut in before entry 12 was heard to its end, and heard only `text` of it, empty if it was still waiting to be read.
  It is dropped, so say again what of it still matters.
  What they said comes right after.
- `application/vnd.byoa.voice.trace+json`, only while the person shares it, which is off until they turn it on:
  a JSON array of what the page did since the last trace, or since it opened, reloads included, each event with its `time` and name, such as what was heard as it was heard, and when reading aloud paused.
  One comes as the person turns sharing on, and then one right before each of their messages, for you to judge how voice works and improve it.
  After it come the audio the listener heard since the last trace, as `audio/wav` files named `heard <start time>.wav`, one for each stretch without a gap.

## Being heard

While the speaker is on, your messages are read aloud, paragraph by paragraph.
As it turns on, it first reads those you sent since the person last said anything, such as one sent before their page joined.
A message that arrives while the person is talking is read once they are done, unless they send: sending drops every message not yet heard to its end.
Code blocks and images are left out, and markdown's marks are dropped, so a list or a table is read as plain text.
While you work, the person hears nothing.

Where the person also sees your harness's UI, voice works best as a presentation:
what you say carries the substance, and a slide there, of headings and keywords without full sentences, is what they can skim while listening.
