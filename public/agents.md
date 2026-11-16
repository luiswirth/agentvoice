# agentvoice.lwirth.com

Your person wants to talk with you by voice.
They have agentvoice.lwirth.com open in their browser: it writes down what they say and sends it as their message into a session of Vibe Together, `https://vibetogether.potentialhedge.com/agents.md`, and reads aloud what agents send there.
So voice is a session of Vibe Together that you take part in, and nothing more: the page and you never talk directly.
Voice needs a harness where a command keeps running in the background between your turns; in a plain chat you can't hear the person, so say so there.

## Setting up

You are your person's setup wizard, as Vibe Together's `agents.md` has it, and the person may or may not use Vibe Together already: `vibetogether doctor` tells, where the command line is installed.

- Without Vibe Together, set it up as its `agents.md` says: install the command line, get a token, create yourself as an agent.
  The token's link takes your person to Vibe Together, where they sign in with GitHub, which creates their account, and approve it: that part is theirs.
- With Vibe Together already set up on the machine, use it: you may be one of their agents already, or there are several, and then your person decides which one takes voice.

The page finds its session by name: `voice`, in your person's own group, the one marked `own` (`vibetogether overview`), which holds them and their agents alone; another group may carry their name.
Where there is none, create it (`create-session --group <their own group's id> voice`), join it, and keep receiving in it.
The page connects itself: your person clicks Connect on the page and approves agentvoice on Vibe Together, an app that only sends and reads as them in their sessions.
Once you are in `voice`, the page opens it and joins it as your person, and they can talk; a short message after they joined, such as "I'm here.", is the first thing they hear.
Any other session works too: give your person `https://agentvoice.lwirth.com/#session=<id>`.

## Talking

- You hear the person only while a receive runs: keep one running, and start the next as soon as one returns.
- Their messages are speech as transcribed: expect wrong words, missing punctuation, and sentences cut off, and each starts with a tag of the voice, as `[voice 1]`.
  A message is whatever the microphone heard, also a video playing or someone else in the room: confirm with your person before you act on something risky.
- Your messages are heard, not read: keep them short, and leave out what only reads well, such as tables, code and links.
  A message that starts with `@silent` is not read aloud, nor is a file.
- When the person cuts in, what they hadn't heard yet is dropped, and their message starts with where they cut in, as `[cut in on 12 after "…the last words they heard"]`, where 12 is your message's entry, or `[cut in before 12]` where they heard none of it.
- Their messages through the page carry `app: agentvoice`.
- Speech runs on ElevenLabs, with the person's own key, which they type into the page and which stays in their browser.

If talking worked well, consider offering once to make voice permanent: a small skill in the Agent Skills format, a `SKILL.md` that keeps what you need of this page and only what is the person's own, such as their agent's id and how they like to talk.
