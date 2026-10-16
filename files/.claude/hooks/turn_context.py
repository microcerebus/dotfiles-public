#!/usr/bin/env python3
"""UserPromptSubmit and PostToolUse hook. Agents guessed timestamps and ran
threads to 500k+ tokens on 9-10 Oct 2026 because neither the time nor the
context size was visible to them, so every prompt gets the real SGT time and
how full the context is.

Past the 250k hard stop the prompt alone is not enough: of the seven threads
that passed it between 14 and 16 Oct, three made 5-16 tool calls after it with
at most one prompt, and the rest saw only "near 250k". So after every tool call
the hook stays silent until 250k, then repeats the stop once per REPEAT tokens
of growth: every call cost about 70 tokens, and one 16 Oct thread made 116
calls past 250k. A per-session file in the temp dir holds the size at the last
stop. It never blocks a call: pausing safely needs tools. Subagent calls are
skipped; the stop is for the thread. Thresholds live in recall.py (HANDOFF,
PAUSE_NOW, HARD_STOP)."""
import datetime as dt, importlib.util, json, os, sys, tempfile
from pathlib import Path

RECALL = Path(__file__).resolve().parent.parent / 'skills' / 'recall' / 'scripts' / 'recall.py'
REPEAT = 5_000
STOPS = Path(tempfile.gettempdir()) / 'claude-turn-context'

try:
    event = json.load(sys.stdin)
except ValueError:
    event = {}


def context():
    """(tokens, advice) from the transcript, or None when it cannot be read."""
    path = event.get('transcript_path')
    if not (path and os.path.exists(path) and RECALL.exists()):
        return None
    spec = importlib.util.spec_from_file_location('recall', RECALL)
    recall = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(recall)
    n = recall.context_tokens(path)
    return None if n is None else (n, recall.context_advice(n), recall.HARD_STOP)


def sentence(advice):
    return f' {advice[0].upper()}{advice[1:]}.' if advice else ''


def stop_file():
    return STOPS / (Path(event['transcript_path']).stem + '.stop')


def last_stop():
    try:
        return int(stop_file().read_text())
    except (OSError, ValueError):
        return None


def record_stop(n):
    try:
        STOPS.mkdir(exist_ok=True)
        stop_file().write_text(str(n))
    except OSError:
        pass


name = event.get('hook_event_name') or 'UserPromptSubmit'
if name == 'PostToolUse':
    found = None if event.get('agent_id') else context()
    if not found or found[0] < found[2]:
        sys.exit(0)
    last = last_stop()
    # Below the last stop means /compact ran: show the stop again on the way back up.
    if last is not None and 0 <= found[0] - last < REPEAT:
        sys.exit(0)
    record_stop(found[0])
    note = f'Context: {found[0] // 1000}k tokens.' + sentence(found[1])
else:
    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).strftime('%a %d %b %Y %H:%M SGT')
    note = f'Current time: {now}.'
    found = context()
    if found:
        note += f' Context: {found[0] // 1000}k tokens.' + sentence(found[1])
        if found[0] >= found[2]:
            record_stop(found[0])
print(json.dumps({'hookSpecificOutput': {'hookEventName': name, 'additionalContext': note}}))
