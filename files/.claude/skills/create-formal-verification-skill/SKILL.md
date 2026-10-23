---
name: create-formal-verification-skill
description: "Create a project-local bounded formal check and rerun skill for an invariant or race, or explain why no verifier is warranted."
disable-model-invocation: true
---

# Create a formal verification skill

Adapted from cursor/plugins pstack 0.15.29, revision `88d47514b82e7c44f00f2b2a72ff6dd12158038c` (MIT, see LICENSE).
Start with the requested subject and read its implementation before choosing a property.
Use the roles and delegation rules in `../arena/references/model-families.md` when a fresh context is needed.
Do not change the subject's code as part of generating its verifier.

## Choose a useful check

State the promise and the harm from breaking it in plain language.
Prefer a bounded model of event ordering for races, retries and state transitions; TLA+ with TLC is the default for that question.
For input properties, prefer a verifier that runs on the actual code.
Do not substitute a hand model of a function when generated inputs against that function would answer the question.

Return **no-verifier** when the subject has no useful formal property, ordinary checks cover the risk, or no approved pinned tool can run it.
Name the reason and the concrete ordinary check to use instead.
Do not generate an empty skill or install a tool to avoid that outcome.

## Resolve the tool before modeling

Read the repository's dependency policy and lockfile.
The verifier and its runtime must come from the repository's pinned inputs.
Record the input revision, package attribute, verifier version and runtime version.
Do not use registry aliases such as `nixpkgs#`, unpinned downloads, curl-to-shell, brew, or global npm installs.
If no pinned source is available, report the blocker and options through the task's owner.

In dotfiles, an authorized temporary invocation can use the root flake's locked nixpkgs without changing a profile:

```sh
nix shell --impure --expr 'let f = builtins.getFlake (toString ./.); p = import f.inputs.nixpkgs { system = builtins.currentSystem; }; in p.tlaplus' --command tlc -workers 1 -config <model.cfg> <model.tla>
```

Run from the repository root.
Confirm the package and runtime on the current platform before relying on this example.
A committed runner that checks tool provenance pins nixpkgs itself by revision and NAR hash, because the daily flake update moves the root lock.
It records a source commit that is already on the target branch, because a rebase changes branch SHAs.
Keep tool output and exit codes; a download failure or timeout is not a passing check.

## Tie the model to the code

Map every transition and assumption to named functions and source locations.
Split reads, writes and checks that can interleave in the implementation.
State the finite bounds, initial states, failure modes, fairness assumptions and excluded actors.
Do not assume the safety property in the model's guards.
Distinguish a bounded model result from proof about all inputs or the running system.

When the current model fails, map the trace back to the source before calling it a defect.
Preserve the counterexample and report it in the code's terms.
Do not weaken the property or silently exclude a reachable case to obtain a pass.
If the model was wrong, record the correction and rerun.

## Leave a rerunnable project skill

Keep models, configurations and output in the repository's existing verification or evidence directory.
Use `.agents/skills/verify-<area>/SKILL.md` for a new project skill unless that repository declares another canonical location.
Include frontmatter, when to run it, one exact command, source coverage, the last source commit checked, bounds, expected output, and what failure means.
Add a drift command whose empty output means no covered source changed since that commit, including uncommitted edits.
Record how to compare changed source with the model before advancing that commit.
Name where the recorded result lives.
For covered changes made without the project skill, tell the reader to read and follow `maintain-formal-verification-skill/SKILL.md` from the user skills directory, since it is explicit-only.

For every claimed safety property, demonstrate a failure on a broken variant.
Change a scratch copy of the real source, reconcile that change into the model using the generated skill, and run the verifier.
A source-drift warning alone is not a semantic counterexample.
Keep the source mutation, corresponding model mutation, output and exit code as evidence.
Drop the scratch mutation and rerun the original model.
Never mutate the live subject, and never report an unexecuted draft as a working verifier.

## Hand off

Report **pass**, **counterexample**, or **no-verifier**, with the selection reason and evidence.
A pass names its bounds and exclusions.
A counterexample names the steps and whether source inspection confirms them; fixes remain a separate task.
Include the command, tool provenance, generated skill path and mutation result.
