#!/usr/bin/env python3
"""PreToolUse(Bash) hook: block two mistakes that rules alone did not stop.

1. Starting containers or VMs. On 9 Oct 2026 a coordinator judged an OrbStack
   VM "local, reversible" and started one; the owner had to intervene. Only the
   command word of each pipeline stage counts, so quoted text, grep patterns,
   commit scopes and heredoc bodies that mention docker pass.
   the owner can allow containers for a while by writing an expiry (epoch seconds)
   to ~/.claude/containers-approved-until, e.g.
   `date -v+2H +%s > ~/.claude/containers-approved-until`.
2. Em dashes in commit messages (AGENTS.md, repeated correction since July).
   Only the message counts: -m/--message values, -F/--file files, and heredoc
   bodies fed to git commit. Grep patterns and other text pass.
3. Handoff notes that leave work "still hosted" in a thread about to end
   (write_guard.py has the story). Only heredocs and echo/printf lines that
   write into a resume note or ~/orchestrator count; greps pass.
Exit 2 blocks the call and shows stderr to the agent. Unparseable commands
pass: this is a guardrail, not a sandbox."""
import json, os, re, shlex, sys, time

EM_DASH = '\N{EM DASH}'
CONTAINER_CMDS = {'docker', 'docker-compose', 'podman', 'colima', 'limactl', 'lima', 'orbctl', 'orb',
                  'multipass', 'vagrant'}
HARMLESS_ARGS = {'--version', '-v', 'version', '--help', '-h', 'help'}
WRAPPERS = {'sudo', 'exec', 'env', 'nohup', 'time', 'command', 'builtin'}
APPROVAL = os.path.expanduser('~/.claude/containers-approved-until')
HEREDOC = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")
STILL_HOSTED = re.compile(r'(?i)\bstill (?:hosts|hosted (?:by|in)|running in)\b')  # same as write_guard.py
HANDOFF_TARGET = re.compile(r'>\s*\S*(?:/\.resume/|\.resume/|resume[^/\s]*$|resume[^/\s]*\s|/orchestrator/)')


def strip_heredocs(cmd):
    """Drop heredoc bodies; they are data, not commands."""
    out, end = [], None
    for line in cmd.split('\n'):
        if end is not None:
            if line.strip() == end:
                end = None
            continue
        out.append(line)
        m = HEREDOC.search(line)
        if m:
            end = m.group(2)
    return '\n'.join(out)


def segments(cmd):
    """Split a command line into simple commands on unquoted ; & | ( ) and newlines."""
    lex = shlex.shlex(strip_heredocs(cmd), posix=True, punctuation_chars=';&|()\n')
    lex.whitespace = ' \t\r'
    lex.whitespace_split = True
    seg = []
    for tok in lex:
        if tok and set(tok) <= set(';&|()\n'):
            if seg:
                yield seg
            seg = []
        else:
            seg.append(tok)
    if seg:
        yield seg


def command_words(seg):
    """Drop env assignments, wrappers and their flags before the command word."""
    words = [w.lstrip('`$') for w in seg]
    while words and (re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*=.*', words[0]) or words[0] in WRAPPERS
                     or (words[0].startswith('-') and len(words) > 1)):
        words.pop(0)
    return words


def starts_container(seg):
    words = command_words(seg)
    if not words:
        return False
    head = os.path.basename(words[0])
    if head in CONTAINER_CMDS:
        # Bare `orb` opens a shell in a VM, so only an explicit version or help call passes.
        return not (len(words) == 2 and words[1] in HARMLESS_ARGS)
    if head == 'open' and '-a' in words:
        app = words[words.index('-a') + 1] if words.index('-a') + 1 < len(words) else ''
        return re.match(r'(?i)(orbstack|docker)(\.app)?$', os.path.basename(app)) is not None
    return False


GIT_COMMIT_LINE = re.compile(r'(^|[\s;&|(])git\s+(?:-[Cc]\s+\S+\s+|--\S+\s+)*commit\b')


def commit_args(seg):
    """Arguments after `git [global options] commit`, or None for any other command."""
    words = command_words(seg)
    if not words or os.path.basename(words[0]) != 'git':
        return None
    i = 1
    while i < len(words) and words[i].startswith('-'):
        i += 2 if words[i] in ('-C', '-c') else 1
    return words[i + 1:] if i < len(words) and words[i] == 'commit' else None


def message_parts(args):
    """Yield ('text', message) for -m/--message and ('file', path) for -F/--file."""
    it = iter(args)
    for a in it:
        for long, kind in (('--message', 'text'), ('--file', 'file')):
            if a == long:
                yield kind, next(it, '')
            elif a.startswith(long + '='):
                yield kind, a[len(long) + 1:]
        if a.startswith('-') and not a.startswith('--'):
            flags = a[1:]
            pos = min((flags.find(f) for f in 'mF' if f in flags), default=-1)
            if pos >= 0:
                rest = flags[pos + 1:]
                yield ('text' if flags[pos] == 'm' else 'file'), rest or next(it, '')


def heredoc_bodies(cmd):
    """Yield (opening line, body) for each heredoc."""
    lines, i = cmd.split('\n'), 0
    while i < len(lines):
        m = HEREDOC.search(lines[i])
        if not m:
            i += 1
            continue
        j = i + 1
        while j < len(lines) and lines[j].strip() != m.group(2):
            j += 1
        yield lines[i], '\n'.join(lines[i + 1:j])
        i = j + 1


def commit_messages(cmd, cwd):
    """Every piece of commit message text in a command line."""
    for opener, body in heredoc_bodies(cmd):
        if GIT_COMMIT_LINE.search(opener):
            yield body
    try:
        segs = list(segments(cmd))
    except ValueError:
        segs = []
    for seg in segs:
        for kind, value in message_parts(commit_args(seg) or []):
            if kind == 'text':
                yield value
            elif value != '-':
                try:
                    yield open(os.path.join(cwd, os.path.expanduser(value))).read()
                except OSError:
                    pass


def handoff_writes(cmd):
    """Text written into a resume note or orchestrator file: heredoc bodies and echo/printf lines."""
    for opener, body in heredoc_bodies(cmd):
        if HANDOFF_TARGET.search(opener + ' '):
            yield body
    for line in strip_heredocs(cmd).split('\n'):
        if re.search(r'(^|[\s;&|(])(echo|printf)\s', line) and HANDOFF_TARGET.search(line + ' '):
            yield line


def approved():
    try:
        return time.time() < float(open(APPROVAL).read().strip())
    except (OSError, ValueError):
        return False


try:
    payload = json.load(sys.stdin)
    cmd = (payload.get('tool_input') or {}).get('command') or ''
    cwd = payload.get('cwd') or os.getcwd()
except (ValueError, AttributeError):
    sys.exit(0)

try:
    blocked = any(starts_container(s) for s in segments(cmd))
except ValueError:
    blocked = False
if blocked and not approved():
    print("Blocked: starting containers, OrbStack or VMs needs the owner's explicit OK (AGENTS.md). "
          'Reproduce Linux-only failures on a GitHub Actions run, or ask the owner.', file=sys.stderr)
    sys.exit(2)
if any(EM_DASH in m for m in commit_messages(cmd, cwd)):
    print('Blocked: the commit message contains an em dash. Use "-" instead (AGENTS.md).', file=sys.stderr)
    sys.exit(2)
if any(STILL_HOSTED.search(t) for t in handoff_writes(cmd)):
    print('Blocked: this handoff note says work is still hosted or running in a thread. Native subagents '
          'die when their session ends, and nothing reports it. List the worker under "Workers" (task, '
          'brief path, what it passed) so the successor respawns it; a T3 delegated task or thread '
          'survives, so name its ID (pause-safely skill).', file=sys.stderr)
    sys.exit(2)
