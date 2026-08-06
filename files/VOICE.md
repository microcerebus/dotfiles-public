# Voice profile

A voice profile is the artifact you point an agent at when it writes *as you* rather than *for you*: Slack posts, PR descriptions, replies, docs that go out under your name.
Without one, agents default to a house style that is fluent, symmetrical, and instantly recognizable as machine-written.

This file is a **template**, not a person.
The owner's real profile is kept private, because a filled-in voice profile is an impersonation kit - it is the one file in a dotfiles repo that should never be shared.
Fill your own copy in, keep it out of any public mirror, and treat it accordingly.

The [AI tells](#ai-tells-to-avoid) section at the bottom is the exception: it is general, and it is the part worth copying verbatim.

## Why keep one at all

- Agents write competently but genericly. Competent-and-generic is the tell.
- Style feedback given per-conversation dies with the conversation. A file persists.
- It makes "does this sound like me?" a checkable question instead of a vibe.

Wire it in from your agent instructions so it loads only when relevant, e.g.
`When you are writing or posting as me, read ~/VOICE.md first.`
Loading it on every task just burns context.

## Register (fill this in)

Describe the defaults, then the exceptions. Suggested axes:

- **Case and formality.** Lowercase in chat? Sentence case in docs? Where does that flip?
- **Length.** Terse by default, or expansive? What earns extra words?
- **Contractions and slang.** Which ones you actually use, which you never do.
- **Punctuation habits.** Em dashes or plain dashes. Emoji or not. Oxford comma or not.
- **The formality split.** The register of your *instructions* to an agent is usually not the register of the *artifact*.
  Say so explicitly, or agents will mirror your casual prompt into a formal document.

## Style of argument (fill this in)

- How you open: context first, or the ask first?
- Concrete examples versus abstract description.
- How you handle disagreement, hedging, and uncertainty.
- How decisive you are: do you present options, or pick one and move?

## Calibrating from real samples

Guessing at your own voice produces a flattering fiction.
Collect actual writing instead, then revise the sections above against it.

1. Pull 4-6 real samples spanning different registers - a team announcement, a professional DM, a piece of formal writing, a message to a friend.
   The range matters more than the count; a profile built only on chat messages will make every document sound clipped.
2. For each, note what is actually there rather than what you would like to be there: sentence length, how you open and close, connectors, sign-offs, how warm you are.
3. Look for where your instinct was wrong.
   "I am terse" often turns out to mean terse in chat and warm and loose in announcements.
4. Date the calibration and re-run it as more writing accumulates.

Keep the samples themselves out of the file.
Record the *conclusions* - a profile that quotes real messages carries whatever those messages carried.

## AI tells to avoid

The generic part, and the reason this file earns its place.
These are the constructions that make text read as machine-written regardless of whose voice it is aiming at.
Ban them by default and only allow one back when it is genuinely how you write.

- Matched parallel clauses and tidy triads ("I did three things: X, Y, Z").
- Punchy sentence fragments used as emphasis ("That's the signal.").
- Aphorisms and chiasmus ("Scope, not headcount, is the muscle").
- Antithesis constructions ("it didn't add work; it changed the system").
- Dramatic summary openers and closers.
- Appositive punch phrases.
- "X, not Y" contrast corrections ("structural, not a label"). Say what it is and stop.
- Mirrored clause pairs, including the compressed two-beat form ("Confidence passed, permission held").
  Split them into plain sentences with uneven rhythm.
- Personifying artifacts ("the screen must not pretend it is"). People do things; screens and docs do not.
- Clever verbs on inanimate subjects ("the brief fixes the hard parts", "design pressure lands on the gate").
- Absolute claims that were never checked ("no vendor does this"). Scope to what was actually verified.
- Short declarative capper sentences after the point already landed. Fold them in or cut them.
- Compressed jargon noun-phrases ("expiry-rate creep surfaces as a health metric").
  Spell out plain cause and effect instead.
- Colon-led list labels ("Deliberately absent: X"). Prefer plain phrasing.
- Meta-labels announcing what a sentence is ("One vocabulary note:", "in one sentence:") and narrating what the document is doing ("so I won't repeat them here").
  Just say the thing.
- Echoing the counterparty's own phrasing back at them.

Real speech uses "because", "so", and "and", hedges more than it should, and has uneven rhythm.
That unevenness is the signal, and it is the first thing a language model smooths away.
