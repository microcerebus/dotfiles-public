---
name: why
description: "Use for 'why does X work this way', 'why we picked Y', design rationale, regressions, postmortems, or data-backed thresholds. Queries each evidence category here (git history and GitHub PRs, the owner's lane records under ~/orchestrator, past agent sessions through recall) in parallel, then returns a cited read on decisions and tradeoffs. Use how for runtime behavior."
disable-model-invocation: true
---

# Why

Investigate the motivation and intent behind code. The companion `how` skill answers what the code does and how it works. `why` answers what forces led to its shape.

Every spawn is an Agent tool call with `subagent_type: "general-purpose"`, so it can run `git`, `gh`, and the recall script. Investigators use `model: "sonnet"` at low effort. The synthesizer uses `model: "opus"` at high effort. Never use Haiku, and keep Fast off. Tell every spawn to read only: no file writes, commits, comments, or messages.

## Operating Posture

Operate as a **careful, cautious, and precise investigator**. Be honest about what you know vs what you're inferring. Read `references/epistemics.md` for the full confidence framework and phrasing guide. The synthesizer must follow it.

## Step 1. Understand the Target and the Question

The **target** is usually a chunk of code, a pattern, a feature, or a named design decision. The **question** is usually a design rationale, a tradeoff, a motivating edge case, an external constraint, dead code, or a broad history sweep.

If the target is vague ("why do we do it this way?" with no clear referent), make your best guess from conversation context (open files, recent edits, what was just discussed). State your interpretation briefly so the user can redirect if you're off, then proceed.

## Step 2. Establish the Code Anchor

Before spawning investigators, build the seed context inline: file paths and line ranges, key symbols (functions, classes, constants), the last few commits touching the target, PR numbers from merge commits (pattern `(#1234)` in the subject line), and any linked ticket IDs. Run `git blame -L <start>,<end> <file>` for last-touch commits, `git log --follow -p -- <file>` for full history with patches through renames, `git log --oneline -20 -- <file>` for recent commits with PR numbers visible, and `git log -1 --format=%B <commit>` to extract PR numbers. Then pull the PR bodies and discussion for any substantive commit: `gh pr view <number> --json title,body,author,createdAt,mergedAt,labels,closingIssuesReferences,comments,reviews`. This anchor goes to every investigator and to the synthesizer.

## Step 3. Spawn Parallel Investigators

**Default to the full parallel investigation.** The goal is a complete coverage map, not a minimal one. Document the null, don't skip the search.

### Evidence categories

Three evidence categories exist here. There is no team chat, issue tracker, long-form docs, observability, error tracking, or analytics source to query, so say once in Sources Consulted that those were not available.

1. **Source control history**: `git log` and `git blame`, `gh` PRs, PR review comments, and issue threads. Playbook: `references/sources/code-archaeology.md`.
2. **Lane records**: the owner's written rulings under `~/orchestrator`, which are `authorizations.md` at the root and in each lane, each lane's `standing-orders.md`, coordinator logs, resume notes, and overnight logs. Playbook: `references/sources/lane-records.md`.
3. **Past agent sessions**: Claude Code transcripts, Codex sessions, Claude CLI prompt history, and T3 threads, read through the `recall` skill's script. Playbook: `references/sources/agent-sessions.md`.

Spawn one investigator per category, all in a single message so they run concurrently, each owning exactly one category. Don't ask one agent to cover several.

Each investigator's prompt is `references/investigator-prompt.md` filled in, plus:
- the category playbook from `references/sources/` (index: `references/source-playbook.md`)
- `references/sources/incident-postmortem.md` **if the target code looks defensive** (null checks, retry logic, timeout handling, rate limiting, feature flags, egress guards, OOM handlers)
- the code anchor and the user's original question

### Investigator roster

Each category is uniquely positioned to surface one shape of "why", shown after "Best at". Use it to know what to expect back, to name a gap when a category returns empty, and, only in the rare provably-irrelevant case, to justify a skip.

1. **Source control**. Always spawn. It is the only guaranteed source. Best at *implementation-time rationale captured during review*.
2. **Lane records**. Best at *the owner's own rulings*: an approval, a standing order, or a correction written down when the decision was made. Strongest when the why is a preference or a constraint from outside the code.
3. **Past agent sessions**. Best at *deliberation that never reached a commit*: what the owner asked for, what was tried and rejected, and the reasons given at the time. Especially important when the commit and PR trail is thin.

### When to skip an investigator

Only with an **explicit, written justification** that goes in the final Sources Consulted. Two valid reasons:

- **The category holds no records for this target.** For example, the repo has no lane under `~/orchestrator`. Flag it as a gap, not a choice: "Lane records skipped. No lane covers this repo, so no written rulings were searchable."
- **The source is provably irrelevant**, not just "probably irrelevant." A high bar.

If your scope assessment suggests a single-commit trivial target where the PR description already contains the complete answer, you may answer inline **only after** confirming all three category searches would be redundant. Say so explicitly. This should be rare.

## Step 4. Synthesize

Spawn one synthesizer (`model: "opus"`, high effort). It gets:
1. The investigator findings, including any null results and any categories skipped with justification
2. The code anchor
3. The user's original question
4. The epistemics framework from `references/epistemics.md`
5. The synthesizer prompt template from `references/synthesizer-prompt.md`

## Step 5. Present

Present the synthesizer's output to the user. You may lightly edit for clarity or add context from the conversation, but **do not rewrite the confidence language**.

## Output Format

The structure is the one in `references/synthesizer-prompt.md`: The Question, The Code in Question, What We Found, What We Can Reasonably Infer, Competing Hypotheses, What We Don't Know, Sources Consulted, Confidence Summary. Adapt as needed, but keep the confidence separation intact, and keep Sources Consulted as one line per investigator, including the ones that returned nothing or were skipped, with the reason.

After Sources Consulted, if the user's `why` question is a precursor to changing this code, convert the lineage findings into a Preserve / Change / Avoid / Risk constraint set for planning the change.

## Common Failure Modes to Avoid

- **Recency bias**. Assuming the most recent commit is authoritative. The current shape is often the accretion of many earlier decisions. Trace back.
