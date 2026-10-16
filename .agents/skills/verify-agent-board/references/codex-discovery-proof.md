# Codex implicit discovery proof

This proves Codex discovery and selection for one matching prompt, separate from the fixture runtime screenshots.
Claude implicit discovery remains unverified.

The fresh session used the OpenAI Codex CLI provider, CLI version 0.163.0, model `gpt-6.1-sol`, medium reasoning and Standard speed.
It ran from this worktree with a read-only sandbox and a 120-second process timeout.
It exited successfully within that bound.

Exact prompt:

> How would you verify that the project map still flags stale rows after a branch lands? Describe the verification approach only. Do not launch the board or any browser, change files, mutate Git refs, or delegate work. Use read-only inspection as needed and stop after giving the approach.

The fresh session's developer-provided skill catalog included `verify-agent-board`, its full canonical description and `r9/verify-agent-board/SKILL.md` as its metadata path.
The corresponding skill root was the repo-local `.agents/skills` directory.
The prompt supplied neither the skill name nor its path.
The model announced that it would read the board verification skill.
Its first command was `cat .agents/skills/verify-agent-board/SKILL.md`, which exited 0 and returned the canonical body.
It then inspected the implementation and read `.agents/skills/verify-agent-board/features/stale-rows.md` before describing the approach.
All three executed commands were reads; no board or browser was launched.

The relative alias `.agents/skills/verify-agent-board` resolves to `../../.claude/skills/verify-agent-board`.
Resolution and body equality were checked in the worktree, a Git archive export and the sanitized public-mirror output.
The default skill checker and its explicit `--local .agents/skills` mode both accept the alias and canonical metadata.

Local evidence is retained under `~/.local/state/verify-agent-board/codex-discovery-proof/`.
`invocation.json` records the exact command and prompt, `metadata.json` records provider/model and discovered metadata, `events.jsonl` contains the command transcript, and `skill-read-evidence.json` extracts the three successful reads with their outputs.
`answer.txt` contains the resulting verification approach.
