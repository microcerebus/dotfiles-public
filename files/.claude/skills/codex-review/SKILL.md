---
name: codex-review
description: Ask the codex CLI for an independent code review of uncommitted changes, a branch diff, a commit, or a specific implementation. Use when the user wants a second-pass review, an extra independent perspective, or the change is broad enough that another reviewer helps.
disable-model-invocation: true
---

# codex-review

Route independent second-pass code review through the [shared model adapter](../arena/references/model-families.md).
Default to Astra High with Fast off and a fresh read-only context.
Use native or T3 delegation when available; the CLI is the fallback transport.
Codex is an outside reviewer: it sees the repo read-only and reports back; you stay the editor of record.

## Workflow

1. Identify the review target: working tree, a branch diff, a commit, or specific paths.
2. For the CLI fallback, read its installed help before constructing the command.
   Select the model explicitly instead of inheriting a user config default:

   ```sh
   codex -c 'model="gpt-6-astra"' -c 'review_model="gpt-6-astra"' \
     -c 'model_reasoning_effort="high"' -c 'service_tier="default"' \
     -c 'sandbox_mode="read-only"' review --uncommitted
   ```

   Use `--base main` or `--commit <sha>` instead of `--uncommitted` for those targets.
   Do not combine a target flag with a prompt; the CLI rejects that combination.
   For a custom focus or selected paths, use `codex exec -m gpt-6-astra -c 'model_reasoning_effort="high"' -c 'service_tier="default"' -s read-only -` with the complete review target and focus on stdin.
   Ask for concrete problems with file:line references and an explicit statement if nothing is found.
3. Read the findings and verify the important claims against the code before presenting them.
   Drop anything you cannot confirm.
4. If codex finds nothing, report "codex found no issues in <target>" - never silently re-run.

## Prompting codex

- Keep prompts short, plain, and self-contained; do not prompt it like a Claude agent.
- State the review target and the output location explicitly.
- Codex calls can time out: retry once, then report the timeout instead of looping.
