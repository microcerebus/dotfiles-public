# Source playbooks

The why skill spawns one investigator per evidence category, each reading the one playbook below for its category.

| Category | Playbook | What it reads |
|---|---|---|
| Source control history | [`code-archaeology.md`](./sources/code-archaeology.md) | git, `gh` |
| Lane records | [`lane-records.md`](./sources/lane-records.md) | `~/orchestrator`: authorizations, standing orders, coordinator logs, resume notes |
| Past agent sessions | [`agent-sessions.md`](./sources/agent-sessions.md) | Claude Code, Codex and T3 history through the `recall` script |

Cross-cutting:

- [`incident-postmortem.md`](./sources/incident-postmortem.md). Add this if the target code looks defensive (null checks, retry, timeout, rate limit, feature flag, egress guard, OOM handler).
