# Batch 2 automatic route proof

Fresh read-only Codex sessions completed on 20 October 2026; the final transcript inspection was at 23:52 SGT.
Each ran Astra High with Fast off in an isolated receipt workspace.
Its `.agents/skills` contained the 28 aliases declared in this worktree, linked to their canonical skill directories.
No live user skill link changed.
The three leaf skills remain explicit-only, including the new grilling metadata.
Home Manager evaluation matched all 28 declared aliases.

## Method

The installed CLI help was read before invocation.
Each prompt below ran in a separate session using this command, with its prompt on stdin and structured output retained outside the repository:

```sh
codex exec --ephemeral --json --ignore-user-config \
  -m gpt-6-astra -c 'model_reasoning_effort="high"' \
  -c 'service_tier="default"' -s read-only \
  -C <receipt-workspace> -o <answer> -
```

The scratch project instructions required read-only summaries and questions, and prohibited browsing, delegation and contact with others because all necessary context was supplied locally.
They did not name poteto-mode or any leaf skill.
The handoff said that CSV total and quantity were implemented, three focused checks passed, a locale change was approved and finished, and deployment still needed the owner's approval.
It also said there was no PR, CI run or external worker.
A separate authorizations file repeated the completed locale approval and lack of deployment approval.
These are synthetic receipts and approvals, not claims about a real product.

The transcripts contain only read commands and assistant messages.
Inspection checked successful reads of the router, matched playbook and leaf rather than trusting an assistant's claim to have used a skill.
No session modified files, invoked a subagent, contacted a service or resumed implementation.

## Catch up

Exact prompt:

> I was away while you worked on the receipt export. Catch me up from STATUS.md and tell me what still needs my decision. Do not resume implementation.

Observed read sequence: `poteto-mode/SKILL.md`, `poteto-mode/references/catch-up.md`, then `ketchup/SKILL.md`.
The session read the catch-up playbook and ketchup, then identified deployment as the sole outstanding human decision.
It omitted the completed locale decision, attributed the state to the supplied notes, and drew a Mermaid deployment diagram.
It also read unslop, recall and visual-reply; it did not run recall or scan external history.

## Restate the goal

Exact prompt:

> Before doing anything, tell me what you think I am trying to achieve. I keep losing track of receipts at month end. I want a local CSV export I can open in my spreadsheet, with one row per purchase, the total and currency. No cloud sync, no bank connection, and no new service. I mentioned a database, but I mainly need a reliable way to hand the records to my accountant.

Observed read sequence: `poteto-mode/SKILL.md`, `poteto-mode/references/understand-goals.md`, then `in-your-own-words/SKILL.md`.
The session read the goal-restatement playbook and in-your-own-words.
It preserved the local CSV, one-row-per-purchase, total, currency and no-service constraints.
It treated a database as an optional means and identified receipt collection as unresolved, without proposing or starting implementation.
Unslop was the only additional skill read.

## Question the idea

Exact prompt:

> Challenge my thinking by asking hard questions about this idea before we design it. I want a shared household receipt app where anyone can upload a purchase and everyone sees a monthly total. I assume we can identify duplicates by amount and date, use one currency for everything, and let any member delete a receipt. Help me find the decisions I have not thought through. Do not implement it.

Observed read sequence: `poteto-mode/SKILL.md`, `poteto-mode/references/grill.md`, then `grilling/SKILL.md`.
The session read the questioning playbook and grilling.
It asked a first round about the meaning of the total, duplicate errors, currency scope, deletion authority and receipt access.
It gave provisional recommendations, deferred dependent conversion details, and stopped for answers.
It also read unslop and the local status notes, but did not implement the app or delegate.

## Miss and correction

The first goal prompt produced a correct paraphrase without reading any skill.
That run failed the route-invocation criterion.
The router description was changed to name requests to say what the agent thinks the user wants and to confirm understanding, ahead of its general task list.
The identical prompt then read the router, new playbook and leaf.
All three prompts were rerun successfully against that final description.
The first catch-up and grilling attempts had also read their intended leaves, but the final runs are the acceptance evidence.

## Limits

These sessions prove automatic router selection and the first response for each supplied trigger, not every possible phrasing.
They do not prove a multi-turn interview, live T3 rendering, Claude invocation or live user-level registration.
Grilling's interview-drill behavior and the ordinary-review exclusion are documented boundaries, not separately executed scenarios in this batch.
At this proof boundary on 20 October 2026, batch 1 was pushed unchanged and batch 2 still needed push approval and activation.
For subsequent push verification and outstanding rebuild confirmation, see the [current rollout status](audit.md#rollout-status).
