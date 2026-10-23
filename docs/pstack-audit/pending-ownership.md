# Pending audit ownership

This table assigns all 42 entries that were pending in the audited snapshot.
The proposed order is a batch number, not permission to bypass a dependency.
"None" means local preparation or read-only verification can start; deploying every dotfiles change still needs push approval and the normal activation path.
Batch 3 reviews the 16 assigned delta entries; this table retains the original 42-entry inventory.
Orchestrator 36 owns the schedule rows and deduplicates existing tasks.
Job-tracker coordinator 36 owns all seven order 71 rows and the later TypeScript refresh.
Levers 5, 2 and 7 stay held until 22 October at 16:00 SGT and are outside this unit.
the owner finalized the exact OPINIONS paragraph in `preference-wording-draft.md`; it is applied locally, with VOICE unchanged.
[Current rollout status](audit.md#rollout-status) records the confirmed pushes and the applied rollout.
Batch 2 closes the package comparison by retaining the local set and confirms built-in plugin enablement.
Wheelhouse and Guide Part 3 remain pending on the named external evidence blockers below.
Batch 3 closes all 16 assigned source reviews: 9 ported, 4 kept local and 3 skipped.
Its ports are pushed and applied; see batch-3-delta.md and batch-3-route-proof.md.
Batch 4 adapts the formal generator and records a bounded updater counterexample; batch 5 adapts its maintenance loop locally.
The subject-code fix is separate.
The table is generated from audit.json by render.py.

| Entry | Owning lane | Blocked by | Proposed order |
|---|---|---|---|
| pstack skill: create-formal-verification-skill | dotfiles | none | 4. Adopt-adapted locally. Project counterexample and no-verifier case recorded; see batch-4-delta.md. The updater race is fixed on main; see docs/formal/autoupdate-handoff/README.md. |
| pstack skill: maintain-formal-verification-skill | dotfiles | none | 5. Adopt-adapted locally with a drift check exercised on the batch 4 proof; see batch-5-delta.md. |
| pstack support: Claude Code package | dotfiles | none | 2. Closed: retain the local set; the replacement loses local patches and adds executable tooling. See batch-2-sources.md. |
| pstack support: Codex skill discovery | dotfiles | none | 1. Migrate routing and prove discovery and fresh-context execution locally. |
| pstack support: Codex role migration for installed skills | dotfiles | none | 1. Migrate routing and prove discovery and fresh-context execution locally. |
| pstack operation: ketchup automatic route | dotfiles | none | 2. Pushed and independently verified at 2e8783a with a fresh Codex catch-up trigger; see batch-2-route-proof.md. |
| pstack operation: in-your-own-words automatic route | dotfiles | none | 2. Pushed and independently verified at 2e8783a with a fresh Codex goal-restatement trigger; see batch-2-route-proof.md. |
| pstack operation: grilling automatic route | dotfiles | none | 2. Pushed and independently verified at 2e8783a with a fresh Codex questioning trigger and explicit-only alias; see batch-2-route-proof.md. |
| pstack operation: Daily reflect retro | schedules | none | 6. Orchestrator 36 checks existing schedules and evidence before changing any task. |
| pstack operation: Daily verification upkeep | schedules | none | 6. Orchestrator 36 checks existing schedules and evidence before changing any task. |
| Other audited source: ig-collection-extract | dotfiles | none | 6. Inspect the unmanaged skill and prepare a managed migration without overwriting the live copy. |
| Other audited source: cc-plugin-you-should-know | external sources | none | 2. Closed: enabled in local settings, with historical runtime records; current notice delivery is unverified. See batch-2-sources.md. |
| Other audited source: Wheelhouse | external sources | authoritative source, provenance and license | 2. Investigated: original source returns 404; discovered copy has no verified successor provenance or license. See batch-2-sources.md. |
| Other audited source: Agent-agnostic workflows | dotfiles | none | 1. Migrate routing and prove discovery and fresh-context execution locally. |
| Review article/video: 1. Async timer lint guard | job-tracker | none | Existing coordinator 36 work: issue 108 proceeds through the selected separate helper-fix PR. |
| Review article/video: 2. Two-strike hosted walkthrough rule | job-tracker | none | In force under order 71; coordinator 36 owns application. |
| Review article/video: 3. PR size cap and scope freeze | job-tracker | hold | Coordinator 36 applies this after issue 108. |
| Review article/video: 4. REVIEW.md and concise project pointers | job-tracker | hold | Coordinator 36 starts this after 22 October at 16:00 SGT. |
| Review article/video: 5. Fresh-context worker pre-review | job-tracker | hold | Coordinator 36 starts this after 22 October at 16:00 SGT. |
| Review article/video: 6. Review rounds, walkthroughs and escapes ledger | job-tracker | hold | Coordinator 36 starts this after 22 October at 16:00 SGT. |
| Review article/video: 7. Reviewer replay on escaped bugs | job-tracker | hold | Coordinator 36 starts this after 22 October at 16:00 SGT. |
| Review article/video: jt map shared context | job-tracker | none | Done: the PR is merged and Orchestrator 35 verified production. |
| Review article/video: CodeRabbit | external sources | the owner's finalization | 6. Inspect existing provider setup and price; present any required provider or paid-plan decision. |
| Upstream delta: correct | dotfiles | none | 3. Source review closed: ported, pushed and applied; see batch-3-delta.md. |
| Upstream delta: ketchup | dotfiles | none | 3. Source review closed: ported, pushed and applied; see batch-3-delta.md. |
| Upstream delta: poteto-mode | dotfiles | none | 3. Source review closed: kept local; see batch-3-delta.md. |
| Upstream delta: interrogate | dotfiles | none | 3. Source review closed: ported, pushed and applied; see batch-3-delta.md. |
| Upstream delta: make-bot-ui | dotfiles | none | 3. Source review closed: skipped; see batch-3-delta.md. |
| Upstream delta: poteto-help | dotfiles | none | 3. Source review closed: skipped; see batch-3-delta.md. |
| Upstream delta: setup-pstack | dotfiles | none | 3. Source review closed: skipped; see batch-3-delta.md. |
| Upstream delta: sharpen | dotfiles | none | 3. Source review closed: ported, pushed and applied; see batch-3-delta.md. |
| Upstream delta: swarm | dotfiles | none | 3. Source review closed: ported, pushed and applied; see batch-3-delta.md. |
| Upstream delta: typescript-best-practices | job-tracker | hold | Coordinator 36 queues this after order 71. |
| Upstream delta: principle-attack-the-premise | dotfiles | none | 3. Source review closed: ported, pushed and applied; see batch-3-delta.md. |
| Upstream delta: principle-fix-root-causes | dotfiles | none | 3. Source review closed: ported, pushed and applied; see batch-3-delta.md. |
| Upstream delta: principle-make-operations-idempotent | dotfiles | none | 3. Source review closed: ported, pushed and applied; see batch-3-delta.md. |
| Upstream delta: principle-migrate-callers-then-delete-legacy-apis | dotfiles | none | 3. Source review closed: kept local; see batch-3-delta.md. |
| Upstream delta: principle-test-behavior-not-implementation | dotfiles | none | 3. Source review closed: ported, pushed and applied; see batch-3-delta.md. |
| Upstream delta: principle-type-system-discipline | dotfiles | none | 3. Source review closed: kept local; see batch-3-delta.md. |
| Upstream delta: Documentation and package metadata | dotfiles | none | 3. Source review closed: kept local; see batch-3-delta.md. |
| Other audited source: Guide Part 3 | external sources | accessible author publication or authoritative link | 2. Investigated: current searches did not establish publication and direct X reading failed. See batch-2-sources.md. |
| Other audited source: Cross-family audit operation | dotfiles | none | 1. Migrate routing and prove discovery and fresh-context execution locally. |
