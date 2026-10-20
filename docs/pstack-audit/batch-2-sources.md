# Batch 2 package and source checks

Read-only evidence collected on 20 October 2026, after the clock check at 23:42 SGT.
No fetched code was executed, installed or enabled.
These findings close the assigned investigation; a named external blocker remains pending in the adoption record.

## Claude Code package

Keep the local set.
The [generated package at the audited revision](https://github.com/cursor/plugins/tree/88d47514b82e7c44f00f2b2a72ff6dd12158038c/harness/pstack/claude-code) declares pstack 0.15.29 and MIT.
It offers upstream packaging and broader playbooks, but replacing the local set would lose behavior we rely on.
Its [Claude adapter](https://github.com/cursor/plugins/blob/88d47514b82e7c44f00f2b2a72ff6dd12158038c/pstack/docs/harness/claude-code.md) maps GPT and Grok requests to the parent Claude session's model.
It does not supply a Codex adapter.

The local patch inventory is in `nix/user.nix` and [the update procedure](../workflow-north-star.md#skill-update-procedure).
The replacement lacks the shared Codex role and fallback adapter, Codex discovery declarations and invocation metadata, and the local automatic entry points.
It also lacks the reduced playbook set, Python plan checker and standalone handoff skills.
The local skills retain T3 rendering, the Needs the owner summary, recall and lane-record integration, git/forge history, tasks-axi follow-ups, and principles in OPINIONS.
Byte comparisons found differences in all ten sampled skills: poteto-mode, why, reflect, recall, ketchup, correct, show-me-your-work, unslop, arena and create-verification-skill.
The package has no equivalents at the local paths for `arena/references/model-families.md`, `poteto-mode/scripts/check-plan.py`, pause-safely or session-pickup.
This is enough to reject a direct replacement; it is not a claim that every upstream line was compared.

The security read covered the following execution and write entry points under the frozen package.

| Entry point | Observed behavior |
|---|---|
| `skills/poteto-mode/scripts/bootstrap.ts` | Runs `bun install --frozen-lockfile` when its dependency marker changes, writes that marker, then restarts with the inherited environment. |
| `scripts/watch-pr/` under poteto-mode | Bootstraps dependencies and polls GitHub through gh, with local git discovery. The inspected forge calls read state. |
| `scripts/orch/orch.ts` and `store.ts` under poteto-mode | Write local state, locks and TSV files, and invoke git and forge commands. The read covered write and subprocess paths, not every branch. |
| `scripts/worktree-audit.sh` under poteto-mode | Fetches origin refs, queries PRs, writes a temporary file and scans Cursor transcripts despite its read-only description. The Claude package retains the Cursor path. |
| `scripts/check-plan.mjs` under poteto-mode | Ships an executable checker different from the local Python checker. |
| `skills/show-me-your-work/scripts/log.sh` | Creates directories and appends TSV rows, with line-break stripping and spreadsheet formula-prefix guards. |
| `skills/setup-pstack/SKILL.md` and the adapter | Instruct the agent to overwrite the entire `~/.claude/rules/pstack-models.md` file. |
| Repository `scripts/generate-pstack-harness-trees.mjs` | Removes and regenerates `harness/pstack`, copying executables and adding adapter instructions. |

No hooks or MCP server configuration appeared in the inspected package manifests.
The documented marketplace install follows the repository rather than this frozen revision.
The package's executable helpers add installation, polling and state ownership that the local workflow deliberately excludes.
Keep the package replacement skipped and review selected upstream skill changes separately in batch 3.
No replacement decision is needed from the owner.

## Built-in plugin

The local configuration explicitly enables `cc-plugin-you-should-know@builtin`.
A filtered read of `~/.claude/settings.json` established that its enabledPlugins value is true.
The corresponding plugin-store file contains runtime session, seen and known records, which establish historical use rather than an installation manifest.
Neither the installed-plugin registry nor the known-marketplace registry lists it.
That is consistent with a built-in plugin, but those absences do not independently prove availability.

Close the configuration-enablement check as adopted.
Fresh account entitlement and current notice delivery were not verified.
A direct read of the [Claude mods documentation](https://code.claude.com/docs/en/mods) failed, so it supplies no additional evidence.
No account identifiers, notice contents or settings were copied into this report.

## Wheelhouse

Keep adoption blocked.
The original [kunchenguid/wheelhouse repository](https://github.com/kunchenguid/wheelhouse), its GitHub API endpoint and its raw README and LICENSE URLs all returned HTTP 404.
That does not establish whether the repository was removed, renamed or made private.

A discovered [public copy at a frozen revision](https://github.com/ImZoomBoy/wheelhouse/tree/b63123e9e18e3c9244a2d21b87715dc70a1daf90) reports no license in the GitHub API and has no root LICENSE.
The API does not mark it as a fork.
Its status as an author-approved successor is unverified.
This copy is evidence for a bounded comparison, not a substitute source selected for installation.

The targeted security read covered its README, decision-handler, deep-review and scan-backstop workflows, and decision-handler code.
Owner checks, current-head checks, action allowlists, separation of the fleet write token from model steps, and execution from a trusted source copy are useful controls.
Cross-repository write authority and default-on CI approvals still require a deliberate permission decision.
Floating checkout/setup-python action tags and unpinned `pip install pyyaml` also weaken reproducibility.
This was not a complete security audit.
The named blockers are an accessible authoritative source, verified provenance and a license permitting adoption; permissions and dependency pinning need review after those are resolved.
No upstream message, repository setup or workflow activation was performed.

## Guide Part 3

No standalone Part 3 publication was verified.
Searches used `"The Complete Guide to pstack Pt. 3"`, `site:x.com/poteto "pstack" "Pt. 3"`, `site:x.com/poteto "pstack" "Part 3"`, and `"pstack" "Part 3" Lauren Tan`.
They returned third-party references and the older Part 2 promise, not a verified author publication.
The known [Part 2 source](https://x.com/poteto/article/2097732320606507506) could not be read directly.
The repository guide's `03-understand.md` is a chapter, not evidence of a standalone Part 3 article.

Keep a publication-evidence blocker until an accessible author publication or authoritative link is available.
This result does not assert that Part 3 has never been published.
