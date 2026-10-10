# <Lane> standing orders

Maintained by the orchestrator from the owner's own words.
Paste this file verbatim into every coordinator thread, worker brief and resume.
Edit or add a numbered line before acting on a new rule.
Last updated <Day DD Mon YYYY, HH:MM SGT> (from `TZ=Asia/Singapore date`).

1. Goal: <outcome and how we know it is done>.
2. Method: docs/agent-team.md roles; the coordinator never writes code.
3. Done: a `live-ui-verified` or `unit-test-verified` ledger row on the exact head SHA. A green build alone is not proof.
4. Review: <review rounds and stall limit, once the owner decides the review policy>.
5. Context: pause safely past about 300k tokens at a phase boundary, always before 500k.
6. Allowed without asking: <merges once gates pass, reversible work, ...>.
7. Not allowed: <deploys, provider settings, containers, ...>.
8. Usage: stop starting new work at <N>% weekly or 85% of the 5-hour window.
9. Report to the orchestrator (<thread id>) when state changes, in at most 5 plain lines.
