# Lane records (~/orchestrator)

## What this source contains

the owner runs agent work in lanes, one per repo or project, coordinated from `~/orchestrator`.
Its files record his rulings in his own words, at the time he made them.

- `~/orchestrator/authorizations.md` and `~/orchestrator/lanes/<lane>/authorizations.md`: what the owner approved, with dates
- `~/orchestrator/lanes/<lane>/standing-orders.md`: rules that outlive one thread
- `~/orchestrator/lanes/<lane>/owners.md` and `lane.json`: who owns what, and the lane's repo
- `~/orchestrator/coordinator-log-*.md`, `overnight-*.md` and `overnight-*.tsv`: what coordinators decided and why
- `~/orchestrator/orchestrator-resume-*.md` and `~/orchestrator/lanes/<lane>/*-resume-*.md`: handoff notes, often with the reason a choice was made
- `~/orchestrator/briefs/`: the briefs workers were given
- The repo's own `AGENTS.md`, `~/OPINIONS.md`, `~/VOICE.md` and `~/.claude/CLAUDE.md`, whose rules often carry a date and the incident behind them

A written ruling from the owner is Direct evidence of intent.
A coordinator's paraphrase of a ruling is Supported at best; find the ruling itself.

## How to search it

```bash
# Which lane covers the target repo
grep -l '<repo-name>' ~/orchestrator/lanes/*/lane.json

# Rulings and logs that name the target
rg -n -i '<symbol|file|feature>' ~/orchestrator --glob '*.md' --glob '*.tsv'

# When a ruling was written or changed (the directory is a git repo)
git -C ~/orchestrator log --oneline -- lanes/<lane>/authorizations.md
git -C ~/orchestrator log -S '<phrase>' --oneline

# Dated rules in the instruction files
rg -n '<topic>' ~/OPINIONS.md ~/.claude/CLAUDE.md AGENTS.md
```

Quote rulings verbatim with the file path and the date line above them.
These files hold personal detail: quote only the lines that bear on the question, and never copy booking references, account identifiers or tokens into the findings.
