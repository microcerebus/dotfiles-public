# Refactor

You own the contract: the structure changes and the behavior does not.
A missing feature or a real bug found on the way is split out and shipped after the structural change.

1. If the change is one or two files with an obvious approach, say so and do it directly.
   Then prove behavior is unchanged as step 6 says (the existing tests plus one run of the real artifact), and commit.
2. Pin the behavior first.
   Run `how/SKILL.md` over the subsystem, then write a characterization test, snapshot or equivalence script that captures what it does today.
   Type check and lint are not a pin.
3. Name the structure the code is missing and the target shape you would build today.
   If the target crosses a function boundary, run `references/architect.md`.
4. Subtract before you add: delete dead code, one-caller wrappers and orphan references first.
5. Move in small steps that keep the pin green.
   Migrate every caller and delete the old API in the same wave, with no shims.
   Grep every rename in strings, docs and back-references.
   Hand mechanical edits to `codex exec` with an exact scope.
6. Prove behavior is unchanged on the real artifact: rerun the pin, and for larger reshapes diff old against new output or smoke-test with the verification skill.
7. Keep the change only if it lowers reader load somewhere; otherwise revert it.
8. Commit in order: the subtraction, then the reshape, then any cleanup.

**Reply.**
The structure that changed, the pin, the equivalence proof, the change in reader load, and what you reverted.
