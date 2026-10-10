#!/usr/bin/env python3
"""PostToolUse(Write|Edit|MultiEdit) hook: flag two mistakes in text an agent
just wrote. Exit 2 shows stderr to the agent; the write already ran.

1. Em dashes in prose. The rule has been in AGENTS.md since July and still
   needed repeating in chat.
2. Handoff notes that leave work "still hosted" or "still running in" a
   thread that is about to end. On 10 Oct a resume note said coordinator 6
   "still hosts #36's resolution review"; that native worker died with the
   session at 14:22, published nothing, and cost #36 about an hour. Same
   check for Bash writes in bash_guard.py."""
import json, os, re, sys

PROSE = ('.md', '.mdx', '.markdown', '.txt', '.html', '.htm', '.tsv')
STILL_HOSTED = re.compile(r'(?i)\bstill (?:hosts|hosted (?:by|in)|running in)\b')


def handoff_note(path):
    """Resume notes and orchestrator state files."""
    return '/.resume/' in path or 'resume' in os.path.basename(path).lower() or '/orchestrator/' in path


try:
    event = json.load(sys.stdin)
except ValueError:
    sys.exit(0)
ti = event.get('tool_input') or {}
path = ti.get('file_path') or ''
text = ' '.join([ti.get('content') or '', ti.get('new_string') or ''] +
                [e.get('new_string') or '' for e in ti.get('edits') or []])
problems = []
if path.lower().endswith(PROSE) and '\N{EM DASH}' in text:
    problems.append(f'{path} now contains an em dash in the text you just wrote. Replace it with "-" '
                    '(AGENTS.md), unless the file quotes or matches the character on purpose.')
if handoff_note(path) and STILL_HOSTED.search(text):
    problems.append(f'{path} says "{STILL_HOSTED.search(text).group(0)}" about a thread. Native subagents '
                    'die when their session ends, and nothing reports it. List the worker under "Workers" '
                    'instead (task, brief path, what it passed) so the successor respawns it; a T3 '
                    'delegated task or thread survives, so name its ID (pause-safely skill).')
if problems:
    print('\n'.join(problems), file=sys.stderr)
    sys.exit(2)
