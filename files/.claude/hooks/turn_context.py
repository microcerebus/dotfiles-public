#!/usr/bin/env python3
"""UserPromptSubmit hook: tell the agent the real SGT time and how full its
context is, every turn. Agents guessed timestamps and ran threads to 500k+
tokens on 9-10 Oct 2026 because neither was visible to them."""
import datetime as dt, importlib.util, json, os, sys
from pathlib import Path

RECALL = Path(__file__).resolve().parent.parent / 'skills' / 'recall' / 'scripts' / 'recall.py'

try:
    event = json.load(sys.stdin)
except ValueError:
    event = {}
now = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).strftime('%a %d %b %Y %H:%M SGT')
note = f'Current time: {now}.'
path = event.get('transcript_path')
if path and os.path.exists(path) and RECALL.exists():
    spec = importlib.util.spec_from_file_location('recall', RECALL)
    recall = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(recall)
    n = recall.context_tokens(path)
    if n is not None:
        if n >= 450_000:
            note += f' Context: {n // 1000}k tokens. Near 500k: use the pause-safely skill now.'
        elif n >= 300_000:
            note += f' Context: {n // 1000}k tokens. Past 300k: use the pause-safely skill at the next phase boundary.'
        else:
            note += f' Context: {n // 1000}k tokens.'
print(json.dumps({'hookSpecificOutput': {'hookEventName': 'UserPromptSubmit', 'additionalContext': note}}))
