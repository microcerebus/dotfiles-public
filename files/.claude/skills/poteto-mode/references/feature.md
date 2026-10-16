# Feature

You own the design.
Plan, delegate, verify, and stay in the lead.

1. If the change is one or two files with an obvious approach, say so and do it directly, without a checkpoint or a worker.
   Then verify it as step 7 says, and commit.
2. Name the data shape first, and pick its organizing structure (a state machine, a typed model, a table) before any logic is written.
3. Run `how/SKILL.md` over the affected subsystem.
4. If a design question is open, run `references/prototype.md` first.
   If the change crosses a function boundary, run `references/architect.md` first.
   For shared code, write the tutorial first (`references/write-docs.md`).
5. Write a throughput checkpoint as four todo items, each filled in or marked `n/a: <reason>`:
   blocking first steps; independent workstreams; shared mutable state (split it rather than serialize); and the smallest safe decomposition.
6. Delegate the code to a worker in its own worktree, with an exact scope: the files, the data shape and the success criteria.
   Read its diff yourself.
7. Verify on the real surface with the repo's verification skill (`verify-<app>` or `control-<app>`), and save the artifact.
   Inconclusive, or a pass on another surface, is not a pass.
8. Commit in small ordered units, and verify each before the next.
9. If the design is contested once built, run `interrogate/SKILL.md`.
   Then run the repo's checks and follow its push rules.

**Reply.**
What you built and for whom, what you chose and why, the throughput checkpoint, the proof, and the open decisions.
Use a table for design alternatives.
