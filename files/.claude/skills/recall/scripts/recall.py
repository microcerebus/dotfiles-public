#!/usr/bin/env python3
"""Search the owner's local agent history: Claude Code transcripts, Claude CLI
prompt history, and Codex sessions. Read-only. Run with `python3 -I`.

  recall.py sessions [--since 7d] [--source claude|codex] [--cwd SUBSTR] [--grep TEXT]
  recall.py messages PATH [--max-chars 1500] [--assistant]
  recall.py grep PATTERN [--since 30d] [--source ...] [--cwd SUBSTR]
  recall.py history [--since 30d] [--grep TEXT]
  recall.py self [--cwd PATH]
  recall.py context [--transcript PATH | --cwd PATH]
Add --json to any command for machine-readable output.
"""
import argparse, datetime as dt, glob, json, os, re, signal, sys

signal.signal(signal.SIGPIPE, signal.SIG_DFL)  # quiet exit when piped into head

HOME = os.path.expanduser('~')
CLAUDE = os.path.join(HOME, '.claude', 'projects')
CODEX = os.path.join(HOME, '.codex', 'sessions')
HISTORY = os.path.join(HOME, '.claude', 'history.jsonl')
# Messages that arrive as "user" but were written by the harness or another agent.
NOISE = ('<local-command', '<command-stdout', '<environment_context>', '<user_instructions>',
         '<permissions', '# AGENTS.md', '<task-notification>', 'Background command completed')


def since_cutoff(s):
    m = re.fullmatch(r'(\d+)([hd])', s or '')
    if not m:
        sys.exit(f'--since takes a value like 12h or 7d, got {s!r}')
    n, unit = int(m.group(1)), m.group(2)
    return dt.datetime.now().timestamp() - n * (3600 if unit == 'h' else 86400)


def local(ts):
    """Transcripts store UTC ISO timestamps; show them in local time (SGT on the owner's Mac)."""
    try:
        return dt.datetime.fromisoformat(ts.replace('Z', '+00:00')).astimezone().strftime('%Y-%m-%d %H:%M')
    except ValueError:
        return ts[:16]


def session_files(source, cutoff):
    pats = []
    if source in (None, 'claude'):
        pats.append(('claude', os.path.join(CLAUDE, '**', '*.jsonl')))
    if source in (None, 'codex'):
        pats.append(('codex', os.path.join(CODEX, '**', '*.jsonl')))
    out = []
    for src, pat in pats:
        for f in glob.glob(pat, recursive=True):
            if '/subagents/' in f:
                continue
            m = os.path.getmtime(f)
            if m >= cutoff:
                out.append((m, src, f))
    return sorted(out, reverse=True)


def user_messages(path, assistant=False):
    """Yield (timestamp, role, text) for typed or relayed messages, skipping tool traffic."""
    codex = path.startswith(CODEX)
    for line in open(path, errors='ignore'):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if codex:
            p = d.get('payload') or {}
            if d.get('type') == 'response_item' and p.get('type') == 'message' and p.get('role') in ('user', 'assistant'):
                if p['role'] == 'assistant' and not assistant:
                    continue
                kind = 'input_text' if p['role'] == 'user' else 'output_text'
                t = '\n'.join(b.get('text', '') for b in p.get('content') or [] if b.get('type') == kind).strip()
                if t and not t.startswith(NOISE):
                    yield d.get('timestamp', ''), p['role'], t
            continue
        if d.get('isSidechain') or d.get('isMeta'):
            continue
        role, c = d.get('type'), (d.get('message') or {}).get('content')
        if role not in ('user', 'assistant') or (role == 'assistant' and not assistant):
            continue
        if isinstance(c, list):
            if any(b.get('type') == 'tool_result' for b in c):
                continue
            c = '\n'.join(b.get('text', '') for b in c if b.get('type') == 'text')
        t = (c or '').strip()
        if t and not t.startswith(NOISE):
            yield d.get('timestamp', ''), role, t


def meta(path, src):
    cwd, first, n = None, '', 0
    for line in open(path, errors='ignore'):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if src == 'codex' and d.get('type') == 'session_meta':
            cwd = (d.get('payload') or {}).get('cwd')
        elif src == 'claude' and not cwd and d.get('cwd'):
            cwd = d['cwd']
    for _, _, t in user_messages(path):
        n += 1
        first = first or t
    return cwd or '?', n, ' '.join(first.split())[:160]


def cmd_sessions(a):
    rows = []
    for m, src, f in session_files(a.source, since_cutoff(a.since)):
        cwd, n, first = meta(f, src)
        if n == 0 or (a.cwd and a.cwd not in cwd):
            continue
        if a.grep and not any(a.grep.lower() in t.lower() for _, _, t in user_messages(f)):
            continue
        rows.append({'modified': dt.datetime.fromtimestamp(m).strftime('%Y-%m-%d %H:%M'),
                     'source': src, 'cwd': cwd, 'messages': n, 'first': first, 'path': f})
    return rows


def cmd_messages(a):
    out = []
    for ts, role, t in user_messages(a.path, a.assistant):
        out.append({'ts': local(ts), 'role': role, 'text': t if len(t) <= a.max_chars else t[:a.max_chars] + ' [trimmed]'})
    return out


def cmd_grep(a):
    try:
        rx = re.compile(a.pattern, re.I)
    except re.error:
        rx = re.compile(re.escape(a.pattern), re.I)  # treat an invalid regex as literal text
    out = []
    for _, src, f in session_files(a.source, since_cutoff(a.since)):
        if a.cwd and a.cwd not in meta(f, src)[0]:
            continue
        for ts, role, t in user_messages(f):
            for hit in rx.finditer(t):
                s = max(0, hit.start() - 160)
                out.append({'ts': local(ts), 'source': src, 'path': f,
                            'context': ' '.join(t[s:hit.end() + 160].split())})
                break
    return out


def cmd_history(a):
    cutoff, out = since_cutoff(a.since) * 1000, []
    if not os.path.exists(HISTORY):
        sys.exit(f'No Claude CLI history at {HISTORY}.')
    for line in open(HISTORY, errors='ignore'):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        t = d.get('display', '')
        if (d.get('timestamp') or 0) < cutoff or (a.grep and a.grep.lower() not in t.lower()):
            continue
        out.append({'ts': dt.datetime.fromtimestamp(d['timestamp'] / 1000).strftime('%Y-%m-%d %H:%M'),
                    'project': d.get('project', ''), 'text': t})
    return out


def cmd_self(a):
    slug = re.sub(r'[^A-Za-z0-9]', '-', os.path.abspath(a.cwd))
    files = sorted(glob.glob(os.path.join(CLAUDE, slug, '*.jsonl')), key=os.path.getmtime, reverse=True)
    if not files:
        sys.exit(f'No Claude transcript under {os.path.join(CLAUDE, slug)}. Pass --cwd with the session\'s working directory.')
    return [{'path': files[0], 'others': files[1:5]}]


def context_tokens(path):
    """Tokens in context as of the last assistant turn: input plus cache reads and writes."""
    with open(path, 'rb') as fh:
        fh.seek(0, 2)
        fh.seek(max(0, fh.tell() - 4_000_000))
        lines = fh.read().decode('utf-8', 'ignore').splitlines()
    for line in reversed(lines):
        if '"usage"' not in line:
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        u = (d.get('message') or {}).get('usage')
        if d.get('type') == 'assistant' and u and not d.get('isSidechain'):
            return sum(u.get(k) or 0 for k in ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'))
    return None


def cmd_context(a):
    path = a.transcript or cmd_self(a)[0]['path']
    n = context_tokens(path)
    if n is None:
        sys.exit(f'No assistant usage record in {path} yet.')
    advice = ('ok' if n < 300_000 else
              'past 300k: pause safely at the next phase boundary' if n < 450_000 else
              'near 500k: pause safely now')
    return [{'tokens': n, 'advice': advice, 'path': path}]


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--json', action='store_true')
    sub = p.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('sessions'); s.add_argument('--since', default='7d'); s.add_argument('--source', choices=['claude', 'codex'])
    s.add_argument('--cwd'); s.add_argument('--grep')
    s = sub.add_parser('messages'); s.add_argument('path'); s.add_argument('--max-chars', type=int, default=1500)
    s.add_argument('--assistant', action='store_true', help='include assistant replies')
    s = sub.add_parser('grep'); s.add_argument('pattern'); s.add_argument('--since', default='30d')
    s.add_argument('--source', choices=['claude', 'codex']); s.add_argument('--cwd')
    s = sub.add_parser('history'); s.add_argument('--since', default='30d'); s.add_argument('--grep')
    s = sub.add_parser('self'); s.add_argument('--cwd', default=os.getcwd())
    s = sub.add_parser('context'); s.add_argument('--transcript'); s.add_argument('--cwd', default=os.getcwd())
    a = p.parse_args()
    rows = globals()['cmd_' + a.cmd](a)
    if a.json:
        json.dump(rows, sys.stdout, indent=1)
        return
    for r in rows:
        if a.cmd == 'messages':
            print(f"[{r['ts']}] {r['role']}: {r['text']}\n---")
        elif a.cmd == 'sessions':
            print(f"{r['modified']} {r['source']:6} {r['messages']:4} msgs  {r['cwd']}\n    {r['first']}\n    {r['path']}")
        elif a.cmd == 'grep':
            print(f"[{r['ts']}] {r['source']} {r['path']}\n    {r['context']}")
        elif a.cmd == 'history':
            print(f"[{r['ts']}] ({r['project']}) {r['text']}")
        elif a.cmd == 'context':
            print(f"{r['tokens'] // 1000}k tokens in context - {r['advice']}")
        else:
            print(json.dumps(r, indent=1))
    if not rows:
        print('No matches. Widen --since, drop --cwd, or check the source exists.', file=sys.stderr)


if __name__ == '__main__':
    main()
