# Pending audit ownership

This table assigns all 42 entries that were pending in the audited snapshot.
The proposed order is a batch number, not permission to bypass a dependency.
"None" means local preparation or read-only verification can start; deploying every dotfiles change still needs push approval and the normal activation path.
The current worker owns only batch 1 in dotfiles.
Orchestrator 36 owns the schedule rows and deduplicates existing tasks.
Job-tracker coordinator 36 owns all seven order 71 rows and the later TypeScript refresh.
Levers 5, 2 and 7 stay held until 22 October at 16:00 SGT and are outside this unit.
the owner finalized the exact OPINIONS paragraph in `preference-wording-draft.md`; it is applied locally, with VOICE unchanged.
Batch 1 routing and discovery are prepared locally; push approval and activation remain outstanding.

| Entry | Owning lane | Blocked by | Proposed order |
|---|---|---|---|
| pstack skill: create-formal-verification-skill | dotfiles | none | 4. Review and adapt the generator, then prove one bounded project case. |
| pstack skill: maintain-formal-verification-skill | dotfiles | none | 5. Follow the first project proof with a source-drift check. |
| pstack support: Claude Code package | dotfiles | none | 2. Compare packaging; keep the local set unless replacement preserves its behavior. |
| pstack support: Codex skill discovery | dotfiles | none | 1. Migrate routing and prove discovery and fresh-context execution locally. |
| pstack support: Codex role migration for installed skills | dotfiles | none | 1. Migrate routing and prove discovery and fresh-context execution locally. |
| pstack operation: ketchup automatic route | dotfiles | none | 2. Add the approved route and verify a realistic trigger. |
| pstack operation: in-your-own-words automatic route | dotfiles | none | 2. Add the approved route and verify a realistic trigger. |
| pstack operation: grilling automatic route | dotfiles | none | 2. Add the approved route and verify a realistic trigger. |
| pstack operation: Daily reflect retro | schedules | none | 6. Orchestrator 36 checks existing schedules and evidence before changing any task. |
| pstack operation: Daily verification upkeep | schedules | none | 6. Orchestrator 36 checks existing schedules and evidence before changing any task. |
| Other audited source: ig-collection-extract | dotfiles | none | 6. Inspect the unmanaged skill and prepare a managed migration without overwriting the live copy. |
| Other audited source: cc-plugin-you-should-know | external sources | none | 2. Verify current enablement, license or publication; close with evidence or a named blocker. |
| Other audited source: Wheelhouse | external sources | none | 2. Verify current enablement, license or publication; close with evidence or a named blocker. |
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
| Upstream delta: correct | dotfiles | none | 3. Review the upstream delta against the local adaptation; retain deliberate skips. |
| Upstream delta: ketchup | dotfiles | none | 3. Review the upstream delta against the local adaptation; retain deliberate skips. |
| Upstream delta: poteto-mode | dotfiles | none | 3. Review the upstream delta against the local adaptation; retain deliberate skips. |
| Upstream delta: interrogate | dotfiles | none | 3. Review the upstream delta against the local adaptation; retain deliberate skips. |
| Upstream delta: make-bot-ui | dotfiles | none | 3. Review the upstream delta against the local adaptation; retain deliberate skips. |
| Upstream delta: poteto-help | dotfiles | none | 3. Review the upstream delta against the local adaptation; retain deliberate skips. |
| Upstream delta: setup-pstack | dotfiles | none | 3. Review the upstream delta against the local adaptation; retain deliberate skips. |
| Upstream delta: sharpen | dotfiles | none | 3. Review the upstream delta against the local adaptation; retain deliberate skips. |
| Upstream delta: swarm | dotfiles | none | 3. Review the upstream delta against the local adaptation; retain deliberate skips. |
| Upstream delta: typescript-best-practices | job-tracker | hold | Coordinator 36 queues this after order 71. |
| Upstream delta: principle-attack-the-premise | dotfiles | none | 3. Review the upstream delta against the local adaptation; retain deliberate skips. |
| Upstream delta: principle-fix-root-causes | dotfiles | none | 3. Review the upstream delta against the local adaptation; retain deliberate skips. |
| Upstream delta: principle-make-operations-idempotent | dotfiles | none | 3. Review the upstream delta against the local adaptation; retain deliberate skips. |
| Upstream delta: principle-migrate-callers-then-delete-legacy-apis | dotfiles | none | 3. Review the upstream delta against the local adaptation; retain deliberate skips. |
| Upstream delta: principle-test-behavior-not-implementation | dotfiles | none | 3. Review the upstream delta against the local adaptation; retain deliberate skips. |
| Upstream delta: principle-type-system-discipline | dotfiles | none | 3. Review the upstream delta against the local adaptation; retain deliberate skips. |
| Upstream delta: Documentation and package metadata | dotfiles | none | 3. Review the upstream delta against the local adaptation; retain deliberate skips. |
| Other audited source: Guide Part 3 | external sources | none | 2. Verify current enablement, license or publication; close with evidence or a named blocker. |
| Other audited source: Cross-family audit operation | dotfiles | none | 1. Migrate routing and prove discovery and fresh-context execution locally. |
