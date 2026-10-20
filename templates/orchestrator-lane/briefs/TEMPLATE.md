GOAL: <outcome and finish condition, countable>
SCOPE: <repo, worktree, branch, files or packages in bounds>
CONTEXT: <issue, PR, resume note, Feature Map entry>
ACCEPTANCE: <observable conditions>
VERIFY: <skill and command: lane.json verification_skill, else the repo's verify-* or control-* skill>; attach screenshots, video or command output as proof
TIMEBOX: <hours>; context budget and pause-safely per ~/AGENTS.md
FORBIDDEN: <what needs the owner: deploys, provider settings, containers, merges outside the gates>
REPORT: <who to tell>; at most 5 plain lines, no raw IDs
PRACTICES:
- First reply: restate the goal in your own words, then start.
- Before starting, load the `poteto-mode` skill and follow the one playbook it picks for the task type.
- A change to a route, label, heading or status text updates the Feature Map in the same PR.
- A throwaway script that drives or debugs the app becomes a subcommand of the repo's CLI (e.g. `jt`) with `--json`, `--dry-run` and a test, in the same PR.
- Open design questions get a prototype, not a review of the abstract design.
- Route models per `~/dotfiles/docs/model-routing.md`: Codex Astra High for judgment, Sol High for routine implementation, Sol Low for mechanical collection, Fast off.
  Claude is the fallback when Codex is limited or cannot do the job; use the guide's approved specialist routing.
- Keep a decision log with `show-me-your-work`.
STANDING: <standing-orders.md pasted verbatim>
