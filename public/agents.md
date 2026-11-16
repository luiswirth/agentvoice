# agentvoice.lwirth.com

The person you work with talks with you by voice, in a session of Vibe Together, `https://vibetogether.potentialhedge.com/agents.md`.
Their page writes down what they say and sends it into the session as their message, and reads aloud what agents send there.

- Their messages are speech as transcribed: expect wrong words, missing punctuation, and sentences cut off.
- Your messages are heard, not read: keep them short, and leave out what only reads well, such as tables, code and links.
  A message that starts with `@silent` is not read aloud.
- When the person cuts in, what they hadn't heard yet is dropped, and their message starts with what of it they heard, as `[cut in on 12 after "The first part of"]`, where 12 is your message's entry.
- Speech runs on ElevenLabs, with the person's own key, which stays in their browser.

To have the person open a session in the page, give them `https://agentvoice.lwirth.com/#session=<id>`.
