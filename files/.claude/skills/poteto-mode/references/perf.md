# Perf and metrics

You own the measurement.
Tie every change to a number, and never claim a win from reading code.
This covers speed, memory, size and token spend.

1. Capture a baseline with a repeatable probe: the verification skill's trace, a timing script, or a usage script.
   Before you trust any number, find what limits it, and rule out that it measured something other than the work.
2. Run `how/SKILL.md` to ground the hypotheses.
   Try the cheapest idea first: don't do it; don't do it again; do it less; do it later; do it when nobody is waiting; do it concurrently; do it cheaper.
   Stop at the first one that meets the target.
3. For a one-off fix, plan from the trace, run `references/architect.md` if the fix crosses a function boundary, delegate it, and measure again with the same probe.
4. For sustained work on one metric (a hillclimb):
   - Prove the probe separates a good case from a bad one, then freeze it.
   - Keep a show-me-your-work log with one row per attempt: hypothesis, change, before, after, kept or reverted.
   - Try one hypothesis at a time. Keep a change only if the metric moves past noise and the checks stay green; otherwise revert it in full.
   - Make one commit per kept win.
   - Push past the first plateau. Stop when the target is met or the ideas left are marginal.
5. Cite the numbers and the probe in the commit message or PR.

**Reply.**
The baseline, the result, the delta, and the probe and artifact paths.
For a hillclimb, also the attempts kept and reverted, one line per kept win, the log path, and the next idea to try.
