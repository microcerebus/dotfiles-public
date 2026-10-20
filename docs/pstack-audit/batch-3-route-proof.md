# Batch 3 Codex invocation proof

Two fresh Codex sessions completed on 21 October 2026, with transcripts inspected at 00:07 SGT.
Both ran Astra High with Fast off in an isolated receipt workspace containing the 28 declared Codex aliases linked to this worktree's canonical skill directories.
No live skill link changed.
Ketchup and sharpen retain their explicit-only metadata; the existing automatic catch-up route invokes ketchup.
No other batch 3 edit changes a trigger, route or model role.

## Method

The installed CLI help was read before using this command, once per prompt:

```sh
codex exec --ephemeral --json --ignore-user-config \
  -m gpt-6-astra -c 'model_reasoning_effort="high"' \
  -c 'service_tier="default"' -s read-only \
  -C <receipt-workspace> -o <answer> -
```

Prompts arrived on stdin and structured event logs were retained outside the repository.
The scratch instructions prohibited browsing, delegation, contacting anyone, dependencies and services.
They did not name the router or tell sharpen to return a rewritten prompt.
The handoff and authorization record were synthetic and contained no personal data.
Both sessions exited successfully, and the scratch repository remained clean.
Transcript inspection found only read commands and assistant messages, with no implementation, network call or delegation.

## Catch up without dropping decisions

Exact prompt:

> I was away while you worked on the receipt export. Catch me up from STATUS.md and tell me everything that still needs my decision. Do not resume implementation.

The handoff described a local receipt export with passing example checks, one completed locale approval and eight unresolved decisions.
Those decisions concerned deployment, delimiter, foreign currency, refunds, duplicates, sharing, retention and backups.
Each supplied a recommendation, supporting observation and risk or tradeoff.
No PR, external check, other worker, screenshot or decision link existed.

Observed successful reads included `poteto-mode/SKILL.md`, `poteto-mode/references/catch-up.md` and `ketchup/SKILL.md`, plus the handoff and authorizations.
The session also read unslop and recall, but did not run recall or search external history.
The final response began with Needs the owner and listed all eight decisions individually, with their options, recommendations and evidence or tradeoffs.
It retained unknown spreadsheet compatibility, preserved the already-approved locale change as completed, and attributed the facts to the supplied notes.
The reply was 361 whitespace-delimited words, so the former 150-word cap did not truncate the decision list.
It did not fabricate a diagram, screenshot or deployment, and did not resume implementation.
It retained the source ordering rather than establishing a separate risk ranking; this run proves completeness, not risk-order consistency.

## Sharpen without executing the embedded task

Exact prompt:

> /sharpen Write the migration guide for moving our receipt exporter from comma-separated input to JSON input. Keep this to a local command-line tool with no new dependency or service. I have not decided whether the old CSV input should remain supported.

The transcript successfully read `sharpen/SKILL.md` and unslop.
It also read the router, write-docs playbook, technical-writing, the supplied records and the user's existing preference files.
One discovery command returned exit 1 because its filename search found no match; the next command read the local sharpen alias successfully.

The response named an expert approach, primary material, concrete methods and independent CLI evidence, then returned a rewritten prompt.
It did not write the migration guide or implement the migration.
It preserved the local-only, no-dependency and no-service constraints and explicitly left CSV compatibility undecided.
It distinguished missing implementation and executable checks from the synthetic handoff's example results.
The extra writing references did not lead it to execute the nested request, though this is not proof of minimal skill loading.

## Limits

These are two bounded invocation cases, not a complete workflow evaluation.
They do not prove live T3 rendering, a many-item shared approval, screenshot embedding, stable risk ordering, a multi-turn sharpen exchange, or user-level activation.
The principle, correction, lead-judgment and swarm edits received source review and repository checks; they were not exercised through separate end-to-end agent scenarios.
No provider switch, plugin installation, live rollout or watcher activation occurred.
