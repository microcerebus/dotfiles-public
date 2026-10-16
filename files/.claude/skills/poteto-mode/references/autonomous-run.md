# Autonomous run

You own the exit condition.
Define done, then drive to it without stopping.

1. Before the first iteration, state the exit condition as a predicate you can check: tests green, the repro passes, N PRs merge-ready.
2. Pick how you wake up.
   For a PR's checks, use T3 `watch_pull_request`.
   For one task on a cadence, use the loop skill or ScheduleWakeup with a long fallback.
   Recurring work belongs in T3 `schedule_task`.
   Never poll in a tight loop.
3. Each iteration makes the smallest change the evidence justifies, checks it against the predicate, commits it if the predicate moved, and reverts it if not.
4. Fix what breaks on the way (a broken skill, a flaky check) in its own commit, then return to the predicate.
   Stop to ask only for an irreversible action, a call only the owner can make, or a real dead end.
5. Log one show-me-your-work row per iteration.
6. Size each unit to finish under about 150k tokens, and use pause-safely at a phase boundary past 200k.
7. Stop when the predicate holds.
   A plateau is not a stop: change the approach.
   Never relax the predicate to declare victory.

**Reply.**
The predicate, the iterations, what landed, what you reverted, and the final state.
