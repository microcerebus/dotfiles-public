#!/usr/bin/env python3
"""PostToolUse(Write|Edit|MultiEdit) hook: flag em dashes in prose an agent
just wrote. The rule has been in AGENTS.md since July and still needed
repeating in chat. Exit 2 shows stderr to the agent; the write already ran."""
import json, sys

PROSE = ('.md', '.mdx', '.markdown', '.txt', '.html', '.htm', '.tsv')

try:
    event = json.load(sys.stdin)
except ValueError:
    sys.exit(0)
ti = event.get('tool_input') or {}
path = ti.get('file_path') or ''
text = ' '.join([ti.get('content') or '', ti.get('new_string') or ''] +
                [e.get('new_string') or '' for e in ti.get('edits') or []])
if path.lower().endswith(PROSE) and '\N{EM DASH}' in text:
    print(f'{path} now contains an em dash in the text you just wrote. Replace it with "-" '
          '(AGENTS.md), unless the file quotes or matches the character on purpose.', file=sys.stderr)
    sys.exit(2)
