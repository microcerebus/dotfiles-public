#!/usr/bin/env python3
"""PreCompact hook (auto): auto-compact is only a backstop for a thread that
missed its 200k handoff (~/AGENTS.md, 2026-10-14), so shape the summary as a
handoff and send the compacted thread to pause-safely instead of carrying on."""
import json, sys

try:
    json.load(sys.stdin)
except ValueError:
    pass
print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreCompact', 'additionalContext': (
    'This thread missed its handoff and is being compacted as a backstop. '
    'Structure the summary as a handoff document for a fresh agent: current goal, work completed, '
    'work remaining, key file paths, running subagents or workers, and the skills the next agent should use. '
    'Reference existing artifacts (plans, briefs, resume notes, commits, diffs) by path or URL instead of copying them. '
    'Redact secrets, tokens and personal data. '
    'End the summary with: "Next: finish the current step, then use the pause-safely skill."')}}))
