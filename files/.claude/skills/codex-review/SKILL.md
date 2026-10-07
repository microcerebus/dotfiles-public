---
name: codex-review
description: Ask the codex CLI for an independent code review of uncommitted changes, a branch diff, a commit, or a specific implementation. Use when the user wants a second-pass review, an extra independent perspective, or the change is broad enough that another reviewer helps.
disable-model-invocation: true
---

# codex-review

Route independent second-pass code review to the codex CLI (model set in ~/.codex/config.toml).
Codex is an outside reviewer: it sees the repo read-only and reports back; you stay the editor of record.

## Workflow

1. Identify the review target: working tree, a branch diff, a commit, or specific paths.
2. Run the purpose-built review subcommand - it is diff-scoped and takes a review stance natively:

   ```sh
   codex review --uncommitted "<focus>"    # staged + unstaged + untracked changes
   codex review --base main "<focus>"      # current branch against a base branch
   codex review --commit <sha> "<focus>"   # a single commit
   ```

   The optional prompt narrows focus; ask for concrete problems with file:line references and an explicit statement if nothing is found.
   For targets `codex review` cannot express (e.g. specific paths only), fall back to `codex exec -s read-only` with a short, self-contained prompt.
3. Read the findings and verify the important claims against the code before presenting them.
   Drop anything you cannot confirm.
4. If codex finds nothing, report "codex found no issues in <target>" - never silently re-run.

## Prompting codex

- Keep prompts short, plain, and self-contained; do not prompt it like a Claude agent.
- State the review target and the output location explicitly.
- Codex calls can time out: retry once, then report the timeout instead of looping.
