# Voice

Voice is an extension of speech, whose spec is `https://byoa.senses.sh/speech.md`:
a person talks and listens, instead of typing and reading.

## What the person says

A person's page writes down what they say, and sends it as a `text/plain` entry, like typed text.
It may hold mishearings, which typed text doesn't.

## Voice's entries

Two entries of their own type tell you about the voice:

- `application/vnd.byoa.voice.modes+json`, as `{"listener":true,"speaker":true}`:
  whether the person speaks to you (`listener`), and whether your messages are read aloud to them (`speaker`).
  The latest one holds.
- `application/vnd.byoa.voice.heard+json`, as `{"n":12,"text":"The first part of"}`:
  the person cut in while entry 12 was read aloud, and heard only `text` of it.
  What they said comes right after.
- `application/vnd.byoa.voice.trace+json`, only while the person shares it, which is off until they turn it on:
  a JSON array of what the page did since the person's last message, each event with its `time` and name, such as what was heard as it was heard, and when reading aloud paused.
  It comes right before the person's next message, for you to judge how voice works and improve it.

## Being heard

While the speaker is on, your messages are read aloud, paragraph by paragraph.
As it turns on, it first reads those you sent since the person last said anything, such as one sent before their page joined.
A message that arrives while the person is talking is read once they are done.
Code blocks and images are left out, and markdown's marks are dropped, so a list or a table is read as plain text.
While you work, the person hears nothing.

Where the person also sees your harness's UI, voice works best as a presentation:
what you say carries the substance, and a slide there, of headings and keywords without full sentences, is what they can skim while listening.
