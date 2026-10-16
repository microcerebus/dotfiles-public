# Skill or prompt change

You own the skill's voice, and the proof that it changes what agents do.

1. Write it lean.
   Keep only prose that changes a decision.
   Tell the agent what to do, and explain only a rule that confuses without its reason.
   Point at structural sources instead of restating them, and delegate to other skills by path.
2. Every model-invocable description loads into every thread, so keep it short and specific, and move detail into the body or `references/`.
   the owner does not type slash commands: a skill nobody routes to goes unused, so make it model-invocable or route to it from one that is.
3. In the dotfiles repo, run `python3 -I scripts/check-skills` (frontmatter, name, LICENSE, links, nix link).
4. Test it in scratch runs.
   Make a detached worktree, link the changed skills in as project skills under `.claude/skills/`, and run `claude -p --model opus --output-format stream-json --verbose` with a prompt a user would really type.
   Keep words like test, eval or judge out of the prompt and the paths.
5. Grade from the transcript, not from what the agent says it did: which skill and reference files it read, which subagents it spawned, and that nothing unrelated loaded.
6. To choose between two versions of a skill, run both on the same prompt, and have one judge from the other model family (`arena/references/model-families.md`) score both outputs blind.

**Reply.**
What changed, the checker's output, and for each scratch run the prompt, what loaded and what the agent did.
