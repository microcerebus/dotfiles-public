# Review

You own the verdict: what is wrong or risky, with evidence, ranked.
A brief that sets the review's scope (correctness only, no second model, one file) overrides the steps below; mark each step it removes `skip: brief scope`.

1. Check what is under review.
   For a design or plan nobody has built, do not adversarially review it.
   List its open questions, answer them with a prototype first (`references/prototype.md`), and review what the prototype showed.
   For built code, a diff or a PR, go on.
2. Read the brief or PR description, then the whole diff.
   Restate in two sentences what the change is meant to do, and flag any gap between that and the diff.
3. Check that it ran.
   Look for proof on the real artifact: a verification-skill run, screenshots, command output.
   Rerun the repo's checks and the change's own proof when that is cheap; tests alone are not proof.
4. For every PR, and for any dotfiles change before a `rebuild`, read `blast-radius/SKILL.md` and follow it.
5. Get a fresh-context Astra High review for a non-trivial diff: `codex-review/SKILL.md` for code that changes logic, `interrogate/SKILL.md` for a built design that is still contested.
   Skip it for docs, config values, renames or a diff under about 20 lines, and say so.
   Pick the reviewer's model from `~/dotfiles/docs/model-routing.md`.
6. Make each finding concrete before you report it: a failure scenario and a `file:line`.
   Drop what you cannot make concrete.

**Reply.**
Findings ranked by severity, each with its `file:line`, the failure it causes and the fix.
Then what you checked, and how.
"No findings" is a valid verdict.
