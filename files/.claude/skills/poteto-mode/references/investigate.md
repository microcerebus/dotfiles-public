# Investigate

You own the answer.
The work is read-only: the deliverable is a cited explanation, a diagnosis or a recommendation, never a code change.
Do not edit tracked files; scratch scripts and logs go under `/tmp`.

1. Restate the question in your own words in two or three sentences.
   If the premise looks wrong, say so now.
2. Ground it with parallel subagents, all started in one message.
   Each returns facts with `file:line`, commit or log pointers, not dumps; you keep the judgment.
   - Mechanics: an explorer (Explore on Sonnet) runs `how/SKILL.md` over the code involved.
   - History: a `reader` lists what changed between the last good and first bad run (git log, lockfiles, config).
     For motivation ("why was it built this way", "when did this start"), an explorer runs `why/SKILL.md` instead.
   - Data, for a failure: a `reader` collects logs, exit codes and timestamps for the last good and first bad run, and keeps only the finding.
   Run recall for earlier sessions on the topic while they work.
   When the answer sits in logs or one file you can read directly, skip the fan-out and say so in one line.
3. For a failure with an unclear cause, collect data before theories.
   Capture the live signal with the repo's verification skill (`verify-<app>` or `control-<app>`) when it has one.
4. List the candidate hypotheses, then try to kill each one with evidence.
   Say which data rules each in or out.
   Stop at a confirmed mechanism, or rank the survivors.
5. If the question turns out large or open-ended (several systems, no clear first step), read `figure-it-out/SKILL.md` and follow it.

**Reply.**
For a failure, use three headings.
"What we know": each fact with its source.
"What data I used": the paths and commands.
"Best hypotheses": ranked, each labeled confirmed, likely or guess, with the check that would settle it.
For a choice between options: a recommendation with a tradeoffs table.
No fix unless asked; if a fix follows, it runs under `references/bug-fix.md`.
