---
name: codex-implement
description: Delegate bounded, clearly-specified implementation work (mechanical migrations, clear-spec features, bulk edits) to the codex CLI (GPT-5.5), usually on a git worktree. Use when the work is token-heavy but well specified, and taste requirements are low.
---

# codex-implement

Route bounded implementation work to GPT-5.5 through the codex CLI.
Good fits: clear-spec implementations, mechanical migrations, data analysis scripts, bulk refactors.
Bad fits: anything user-facing (UI, copy, API design) or ambiguous - keep those on Claude models.

## Workflow

1. Write the spec first: exact scope, files it may touch, and the definition of done.
   If you cannot write that in a few sentences, do not delegate.
2. Prepare an isolated worktree so codex cannot disturb other work:

   ```sh
   WT=$(mktemp -d)/impl && git worktree add "$WT" -b codex/<topic>
   ```

3. Run codex with workspace-write access scoped to the worktree:

   ```sh
   codex exec -C "$WT" -s workspace-write "<the spec>. Commit your work with a conventional commit message. When done, summarize what changed and list anything you could not complete."
   ```

4. Review the resulting diff yourself (or via codex-review) before merging anything back.
   Judge the output, not the price tag: if it misses the bar, redo the work with a smarter model.
5. Clean up: `git worktree remove "$WT"` once the branch is merged or abandoned.

## Prompting codex

- Keep prompts short, plain, and self-contained; codex does not need Claude-style scaffolding.
- If codex reports nothing to do, relay that verbatim with the target it inspected - do not re-run silently.
- Codex calls can time out: retry once, then report the timeout instead of looping.
