# Plan

You own the plan, not the code.
A plan is a checklist an owner runs box by box and a reviewer audits from the evidence.
Write it after the design is settled (`references/prototype.md`, `references/architect.md`), and do not implement while planning.

1. If the change is one or two files with an obvious approach, skip the plan.
   Say so, and do the work under `references/feature.md`.
2. Settle open questions by prototype before you write (`references/prototype.md`).
   Do not adversarially review a design nobody has built.
   List its open questions and answer them with a prototype first.
   Keep each prototype's path and screenshots for Appendix A.
   Ask the owner only about a product or taste call no run can settle, and give options.
3. Explore with subagents that return file pointers, conventions, test commands and entry points, not dumps.
4. Copy the skeleton below into the plan file and fill every placeholder.
   One section per PR.
   Each PR is one small, self-contained change with its own evidence; small independent PRs beat stacks.
5. Write it under `technical-writing/SKILL.md` (the body is a how-to; explanation and reference go in the appendices), then apply unslop.
6. Run `python3 -I <this skill's directory>/scripts/check-plan.py <plan.md>` and fix every line it prints.
7. Hand back the plan path and the checker's output, then stop.
   Execution starts on the owner's go.
8. Delete the plan file in the program's last PR.
   A plan lives in the repo only while it is in flight, so other agents can see the work; a finished plan left behind misleads them.

**Verification rule.**
Tests alone are not sufficient verification.
A PR is verified only when its unit and live boxes are checked, and a live box means the code ran on the real surface through the repo's verification skill and left a saved artifact.
That rule opens every Verify block.
A PR that claims a speed, size or token change adds a **Verify, perf.** block: the metric, the probe, the baseline measured on main first, and the number that fails.
A PR that changes an interaction is review-gated: screenshots or a short video go to the owner before merge.

````markdown
# <Program> plan

<Under ten lines: what changes, for whom, and the PR ids in order.>

## How to read this

One box is one unit of work, and each box names the evidence that checks it.
Check a box only when its evidence exists: a file, a log line, a screenshot, a test run or a commit.
Delete this file in the last PR.

Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are checked.

## <Task as a verb phrase> (<PR id>)

**Depends on.** <PR id, or None.>

**Files.**

- [ ] Edit `<path>`.

**Build.**

- [ ] <One change. Name the symbol and the file.>

**You see.**

- [ ] <One observable result: the exact log line or screen state.>

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are checked.

- [ ] <Test file and the case it gains.> Run `<command>`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit and live boxes are checked.

- [ ] <Scenario driven through the verification skill at the PR head.> Save `<artifact>`. Pass when <predicate>.
- [ ] Regression against main: <the same scenario on main>. Pass when <predicate>.

**Review gate.** <Screenshots and a video go to the owner before merge, or: None. <PR id> changes no interaction.>

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] This plan file is deleted in the last PR.

## Appendix A. Prototype evidence

<Each open question a prototype answered, with its path and screenshots. Each question still unproven.>

## Appendix B. Alternatives rejected

<Each approach weighed, and why it lost.>

## Appendix C. Risks

<Each risk, the PR it lands in, and what the owner watches.>
````

**Reply.**
The plan path, the PR ids with their dependencies and the review-gated ones, what the prototypes proved and what stays unproven, and the checker's output.
