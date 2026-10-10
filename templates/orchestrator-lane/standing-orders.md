# <Lane> standing orders

Maintained by the orchestrator from the owner's own words.
Paste this file verbatim into every coordinator thread, worker brief and resume.
Edit or add a numbered line before acting on a new rule.
Last updated <Day DD Mon YYYY, HH:MM SGT> (from `TZ=Asia/Singapore date`).

1. Goal: <outcome and how we know it is done>.
2. Method: docs/agent-team.md roles; the coordinator never writes code.
3. Done: a `live-ui-verified` or `unit-test-verified` ledger row on the exact head SHA. A green build alone is not proof. A verdict carries over a clean update to main when `git range-diff` shows the PR's own commits unchanged and CI passes on the new head; after a conflicted update, only the conflict resolution gets a quick fresh review.
4. Review: Fable 5.1 reviews risky PRs (<sign-in, deploy wiring, screens the owner uses>) and acts as the verifier; Opus 5.5 at xhigh in a fresh context reviews the rest. At most two review rounds per PR, then the coordinator decides. A PR open for 8 hours of active work is flagged as a stall.
5. Context: pause safely past about 300k tokens at a phase boundary, always before 500k.
6. Allowed without asking: <merges once gates pass, reversible work, ...>.
7. Not allowed: <deploys, provider settings, containers, ...>.
8. Usage: stop starting new work at <N>% weekly or 85% of the 5-hour window.
9. Report to the orchestrator (<thread id>) when state changes, in at most 5 plain lines.
