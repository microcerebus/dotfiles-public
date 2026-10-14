# Incident & Postmortem Context

- **Git**: commits with messages like "fix for incident", "add defensive check", "revert" followed by "re-apply with..." are strong signals
- **GitHub**: issues and PRs labeled `incident`, `bug`, `regression`, or `postmortem`, and failed CI runs (`gh run list`) around the dates the target code was added
- **Lane records**: overnight logs, coordinator logs and resume notes from the days the target code was added, and any `AGENTS.md` "Sharp edges" entry that names the failure
- **Past agent sessions**: `recall` grep for the error text, the symptom, or the word "broke" in the window around the change
