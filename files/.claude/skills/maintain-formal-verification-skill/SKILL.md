---
name: maintain-formal-verification-skill
description: "Bring a project's formal verification back in line after the code it covers changed: detect drift since the recorded sync commit, update the model from the code, rerun with the pinned tools, and say whether each failure is drift in the verification or a bug in the code."
disable-model-invocation: true
---

# Maintain a formal verification skill

Adapted from cursor/plugins pstack 0.15.29, revision `88d47514b82e7c44f00f2b2a72ff6dd12158038c` (MIT, see LICENSE).
A formal check proves a property of what it describes.
When the code changes and the verification does not, the check can keep passing while it describes code that no longer exists.
That pass is the dangerous case, because it looks like a proof.

This is the upkeep loop for a project verify skill made by `create-formal-verification-skill`, or any project-local skill that runs a model checker, prover or code-level verifier against named code.
The project skill handles a change an agent makes while using it.
This skill handles the changes that skipped it: merges, edits made without the skill, and drift across many commits.
Use the roles and delegation rules in `../arena/references/model-families.md` when a fresh context is needed, for example to replay a counterexample independently.

## Outcomes

Give each check one outcome, and say which:

- **in sync**: no change since the sync commit alters what the check describes, and the check returns its recorded result.
- **updated**: the code changed, the verification now describes the new code, and the check passes.
- **bug**: the verification describes the current code, and the code breaks the property.
  This is a finding about the code, not drift.
- **blocked**: the check could not be brought back in line or could not run.
  Say exactly why.

A check can be both updated and bug: the update makes the verification describe the code again, and then the property fails on it.
A check whose recorded result is already a counterexample stays in sync while nothing covered changes and the same trace returns; report the open bug with it.

## Edit scope and tools

Edit only the verification: models, configurations, harnesses, property files, source maps and proof notes, the runner's recorded source hash and commit, and the verify skill.
Never edit product code during a run unless the user asks.
When a property fails on the current code, do not weaken the property or the model to make it pass.

Run only the verify skill's recorded command, its pinned runner and Git.
Do not add a verifier, change its version, or use registry aliases such as `nixpkgs#`, unpinned downloads, curl-to-shell, brew or global npm installs.
If the runner cannot resolve its pinned tools, the outcome is blocked.
If an update needs another tool or version, stop and report the options to the task's owner.

## Pass

1. **Find the checks.**
   A verify skill has no fixed name; find it by what it does, usually under `.agents/skills/verify-*/`.
   Read each one you find, or the one the user named.
   For each check, collect the property, the covered code, the bounds and assumptions, the run command, the drift command, the sync commit and where its recorded result lives.
   If no verify skill exists, stop and point at `create-formal-verification-skill`.
   If the skill records no sync commit, use the last commit that changed the verification files, and say that you did.

2. **Detect drift.**
   Run the verify skill's drift command when it has one.
   Otherwise diff the covered files from the sync commit to the working tree with `git diff --stat <sync> -- <covered paths>`, which includes uncommitted edits.
   Empty output from every drift command means nothing covered changed; still run step 3.
   If there is no drift command, or the verify skill does not say that its drift command covers all of its covered code, do step 4's search for moved code and new callers before calling the check in sync.
   Git diffs do not see untracked files; list them too.

3. **Run it as it is.**
   Run each check once before changing anything, and record the result.
   A pass tells you that the old description still holds, not that the code is correct.
   A failure or a runner's source-drift refusal can be drift or a bug; do not decide which until step 6.
   If the drift commands were empty and the run reproduces the recorded result, including the same counterexample trace, the outcome is **in sync**.
   Report that in one line, change nothing and stop.

4. **Read every change to covered code.**
   Read in full what the drift commands found: the same commands without `--stat`, with the same path and pattern filters.
   Read each commit message from `git log <sync>..HEAD` with those filters.
   Look for code that moved: a covered function that is renamed, split or moved to another file is still covered.
   Look for new code that touches the guarded state, such as a new caller of a guarded command.
   Classify each change:
   - **No effect.** It alters nothing the verification describes, such as formatting, comments or uncovered paths.
     Check this against the model or harness, not against the commit message.
   - **The verification no longer describes the code.** An indivisible step is now two, a branch was added or removed, a check moved, a new path reaches the guarded state, or a value has a new range.
     The model or harness must change.
   - **The promise changed on purpose.** Evidence in the change says so: a doc comment, tests, a changelog or the commit message.
     The property must change, and you must cite that evidence.
   - **The promise may be broken.** The code changed and no evidence says the promise changed.
     Treat a failure that follows as a bug candidate.
     An uncommitted edit has no commit message; without a doc comment or test that states the new promise, it falls here.
   A change to behavior that no property checks, such as a removed guard, needs no property change, but report it as uncovered.
   An unchanged result says nothing about it.

5. **Update from the code, not from the result.**
   Change the model or harness so that each changed part again maps to source a reviewer can open.
   Keep one indivisible step in the code as one step in the verification, and split reads, writes and checks that can interleave.
   Write the update from the code before rerunning, and do not shape it by what makes the check pass.
   Change a property only for a promise that changed on purpose; record the old wording, the new wording and the evidence.
   Keep the bounds unless the change makes them wrong, and report any reduced bound.

6. **Rerun and judge each result.**
   - **Pass:** the description may have lost the ability to fail.
     Break a scratch copy of the new code the way the property guards against, such as removing a new check or reordering a new step, reconcile that edit into a scratch model, and confirm the check catches it.
     Never mutate the live subject.
     Keep the source diff, model diff, output and exit status, then restore the scratch copies byte for byte.
   - **Fail:** replay the counterexample against the real code, step by step.
     If a step cannot happen in the code, the verification is wrong; fix it and say what was wrong.
     If every step can happen, it is a bug.
     Name the commit that introduced it, tell the counterexample as steps in the code's own words, and state the harm in one sentence.
     Write the reproduction as a step-by-step trace against the source; do not run the subject or an activation.
     It is report evidence, not a product change.

7. **Update the verify skill.**
   Update the covered code, commands, drift command, bounds, assumptions and sync commit.
   Set the sync commit to the commit you checked, and use a commit already on the target branch, because a rebase changes branch SHAs.
   If the checked code is not on that branch yet, land it first and record its commit in a follow-up.
   Do not move the sync commit for a blocked check, and say so.
   Then follow the verify skill once as the next agent would, so that you know its steps still run.

Write reruns where the runner already writes them, usually an ignored reruns directory beside the committed evidence.
Keep run notes in a scratch location; do not commit them.

## Report

For each check, report:

- the outcome, and the commits you read;
- what changed in the verification and why: the code changed shape, or the promise changed on purpose, with the evidence;
- the rerun result, and the break that shows the updated check can still fail;
- each bug in plain words: the counterexample as steps in the code's words, the harm, and the commit that introduced it;
- the tool provenance the runner recorded;
- what the verification still does not cover, including new code it should cover and changed behavior no property checks.

Say outright which failures were drift in the verification and which were bugs in the code.
For a check that passed before the update and fails after, say that the old pass was on a stale description.
Put verification updates in a commit of their own, separate from any product fix.
