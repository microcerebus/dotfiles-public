# Independent model runs

Read `~/dotfiles/docs/model-routing.md` before assigning roles.
Codex is the default, including when the parent runs on Claude.
Fresh contexts provide independent attempts and reviews; multiple Codex runs do not constitute cross-family evidence.
Use Claude only for a demonstrated capability gap, a confirmed Codex usage limit, or an explicit task-level exception.
A request for another model family is such an exception; record the actual models used.

## Assign roles

| Work | Default | Effort |
|---|---|---|
| Design, architecture, investigation synthesis, review and judging | `gpt-6-astra` | High |
| Routine implementation with an explicit acceptance check | `gpt-6.1-sol` | High |
| Mechanical collection, scanning and formatting | `gpt-6.1-sol` | Low |

Keep Fast off.
If Astra alone is unavailable, use Sol High before a provider fallback.
Use independent Astra contexts for arena candidates, adversarial reviewers and the final judge unless the brief calls for a supported comparison.
The judge never sees candidates while they are being written and never edits them.
Keep labels tied to the role and actual model, not an assumed provider.

## Choose the available delegation tool

Use T3's live `orchestrator_capabilities` catalog before choosing provider and model identifiers.
For same-provider work, native subagents are suitable when they support the selected model.
Use T3 `delegate_task` when they do not, for another provider, or for a writer needing `isolation: "worktree"`.
Track each returned taskId and read the completed artifact, not only the summary.
Start a new task for every independent review round, with the brief and prior findings included.
Do not create top-level threads to represent subagents.
Respect the lane's concurrency and pace limits; a playbook's suggested parallelism does not override them.

If the host has no suitable delegation tool, run the Codex CLI with a self-contained brief supplied on stdin.
Read the installed CLI help before constructing its options.
Select the model and `model_reasoning_effort` explicitly, keep the standard service tier, and use read-only sandboxing for collection and review.
A writing worker needs its own worktree and a scope that excludes unrelated changes.
Do not create a second writable checkout for a read-only task.
Read the output file and inspect any edits before accepting the result.

## Failures and fallback

Inspect partial results before retrying an interrupted action.
Retry a timeout once; after that, report a dropped attempt rather than silently changing providers.
A tool error or timeout is not proof of a usage limit.
Never enable a paid API key to bypass an exhausted allowance.
On a confirmed Codex limit, follow the routing guide's Claude fallback and browser-state rules.
Commit work in progress before a provider switch and never delete a dirty worktree.
When using Claude, select Opus and the role's fallback effort from the guide; do not treat Claude as a required judge while Codex can do the task.
Report a single-provider run as such and keep the same evidence and acceptance checks.
