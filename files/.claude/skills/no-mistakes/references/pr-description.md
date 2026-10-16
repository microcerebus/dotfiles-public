# PR descriptions

Use this format for every PR body, whether the no-mistakes pipeline opens the PR or you open it by hand.

## Template

Fill every section.
Delete "Before and after" when the change has no visual scope, and delete "Follow-ups" when there are none.

```markdown
## Context and problem

<!--
Why the change is needed: the problem, who hits it, and when.
Link the issue.
-->

## Solution

<!--
What you added, changed and removed.
Add ### Frontend, ### Backend, ### Data or ### Tests only when the PR has that kind of change.
-->

## Reproduce and test

<!--
Short steps: what the reviewer does and what they see.
Or one sentence linking the issue that holds a longer flow.
-->
1.

## Before and after

<!-- Same scenario, viewport, theme and state on both sides. -->

| Before | After |
| --- | --- |
| ![Before: ](https://) | ![After: ](https://) |

## Follow-ups

<!-- Work this PR knowingly leaves undone. -->
-
```

## Sections

**Context and problem.**
Say what is wrong or missing and why it matters now, in words a reviewer from outside the project can follow.

**Solution.**
Say what the PR adds, changes and removes, and explain any decision a reviewer would question.
Describe new tests by what they prove, for example "a Playwright case checks that a pending card survives a reload", not by counts.
A complex change gets as much prose as it needs.

**Reproduce and test.**
Give a few short steps, each with the action a user takes and what they should see.
For a bug fix, the steps show the bug on the base branch and show it gone here.
For a hosted app, link and use the exact preview deployment of this PR's head, such as its Vercel Preview.
For a tool with no deployment, such as a CLI or a local board, start from the command or page a user opens.
When the flow is long, write one sentence that says what it proves and link the issue or ticket that holds it.
Cover persistence after reload, error handling and access rules when they affect the change.
You don't need Gherkin or a catalog of every case.

Run the flow yourself before you describe it.
Use the agent Chrome (Google Chrome Beta, driven through Codex) for a hosted flow, and Playwright for checks that must repeat on every change.
A local fixture run or a list of commands doesn't show hosted behavior, so it doesn't replace the flow.

**Before and after.**
Required when anything a user sees changes: layout, styles, copy or a rendered state.
Show real before media and real after media, each labeled.
Use screenshots for static appearance and recordings for interaction, loading and focus.
Host each file where the reviewer can open it.
`gh-axi pr edit <number> --attach './after.png#After'` uploads an image or video to GitHub (gh-axi 0.1.41, needs gh 2.99 or later).

**Follow-ups.**
List only work this PR knowingly leaves undone, with a link when it is tracked.

## What stays out

- Routine CI results: test counts, pass ratios, "lint passes", lists of commands you ran, and run logs.
  CI owns them.
  The checker catches only common CI-result patterns, such as counts of passed tests, "all tests pass", "lint passes", a table row like `| Typecheck | ✅ |`, and a list of commands followed by "pass".
  Other wordings pass it, so leave out every CI result, not only the ones it catches.
  Link a run when a reviewer needs one.
- Status and process sections, such as asks for the owner, review rounds and rebase notes.
- Placeholders, local paths, private URLs and personal data.

## Check the posted body

```sh
node ~/dotfiles/scripts/check-pr-description.mjs --body-file "$body" --visual-scope true
```

In a repo that pins its own copy of the checker, run that copy, because the repo's CI runs the same version.
Set `--visual-scope true` when anything a user sees changes, and when you are not sure.
The checker exits 0 on a pass, 1 with findings, and 2 on a usage error.

The checker reads text only, with no network call and no model.
It flags missing, unknown, duplicate, empty or out-of-order sections, common CI-result patterns, and a Reproduce and test section that holds only commands.
When visual scope is true, it also flags a Before and after section without labeled before and after media on https URLs, the same media URL used for both sides, and `localhost` and other loopback hosts.
In a Before and after table, the header column names the side, so GitHub's generic `alt="Image"` markup is fine there.

A pass proves the body has the right shape.
It doesn't prove that the flow works, that a preview link matches the PR head, that media loads for the reviewer, or that media shows the change.
Check each of those yourself and report them as separate claims.
