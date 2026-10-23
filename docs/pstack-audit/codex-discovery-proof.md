# Batch 1 Codex discovery proof

Batch 1 prepares the approved routing and skill registration locally.
Nothing was installed, pushed, rebuilt or activated.
The eight routing decisions are accepted, and the finalized OPINIONS paragraph is applied exactly in `files/OPINIONS.md`.
VOICE and the adjacent tried-and-dropped list are unchanged.

## Discovery and invocation

The installed Codex CLI reports version 0.163.0.
Its app-server `skills/list` method returned 15 skills for the audit checkout before registration, with neither poteto-mode nor how present.
An isolated scratch repository then linked the 27 proposed skills under `.agents/skills` to the canonical files in this worktree.
The same method returned 41 skills, including poteto-mode and how, with no discovery errors.
Counts include existing system skills and deduplicate overlapping names; they are not a claim of 41 new installations.
Nix evaluation independently confirmed the proposed 27 Home Manager aliases.
The [Codex skill documentation](https://learn.chatgpt.com/docs/build-skills) documents the `.agents/skills` discovery root.

A fresh Astra High session received a natural request to explain a small receipt calculation.
It opened poteto-mode, selected its explanation playbook, read how, and inspected the fixture.
The answer correctly explained price times quantity, entry count rather than total quantity, the empty case, and the lack of validation or rounding.
The session did not delegate, browse or modify files.
The invocation used `codex exec --ephemeral --json --ignore-user-config -m gpt-6-astra -c 'model_reasoning_effort="high"' -c 'service_tier="default"' -s read-only -C <scratch> -o <answer> -`, with the brief on stdin.

A separate fresh Sol Low session inspected only its initial skill catalog.
It reported poteto-mode, unslop and correct as advertised, with how, arena and tdd absent.
Those explicit-only skills remain discoverable through `skills/list` and readable when an invoked workflow requests them.
Their `agents/openai.yaml` files set `policy.allow_implicit_invocation` to false, matching the existing Claude invocation policy.

## Checks and limits

The checker rejects missing or incorrectly typed invocation policy, accidental automatic invocation of explicit-only skills, and aliases that point at a different canonical skill.
Its new regression fixtures failed against the old checker and passed after the change.
The CLI also reproduced the existing codex-review example failure: `--uncommitted` cannot be combined with a prompt.
The skill now separates target-only review commands from custom-focus `exec` briefs and selects Astra High explicitly.

These checks prove discovery, automatic router selection, nested skill reading and metadata behavior in a fresh scratch session.
They do not prove every playbook end to end, live user-level registration, a cross-provider comparison or a production rollout.
Push and activation are now done (see the [current rollout status](audit.md#rollout-status)); the audit keeps the rollout entries pending while full arena and audit workflow execution remain unproven.
The watcher remains disabled, and held levers remain outside this unit.

## Independent review

A fresh read-only Astra High reviewer, with Fast off, found no actionable issues in the batch 1 diff.
It independently checked the 27 canonical aliases, all 18 explicit-only policies, approved routing and lane limits, and the exact preference replacement.
It reran the 20 checker tests, the repository skill checker, generated audit check and whitespace check.
It confirmed that the discovery logs support the stated scratch results and that live rollout and full arena/audit execution remain pending.
The checker validates declared aliases; it does not enforce a permanent inventory of required aliases.
The separate Nix comparison verifies this batch's intended set, while any future removal still needs review.
