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


def starts_container(seg):
    words = [w.lstrip('`$') for w in seg]
    while words and (re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*=.*', words[0]) or words[0] in WRAPPERS
                     or (words[0].startswith('-') and len(words) > 1)):
        words.pop(0)
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


def approved():
    try:
        return time.time() < float(open(APPROVAL).read().strip())
    except (OSError, ValueError):
        return False


try:
    cmd = (json.load(sys.stdin).get('tool_input') or {}).get('command') or ''
except ValueError:
    sys.exit(0)

try:
    blocked = any(starts_container(s) for s in segments(cmd))
except ValueError:
    blocked = False
if blocked and not approved():
    print("Blocked: starting containers, OrbStack or VMs needs the owner's explicit OK (AGENTS.md). "
          'Reproduce Linux-only failures on a GitHub Actions run, or ask the owner.', file=sys.stderr)
    sys.exit(2)
if re.search(r'\bgit\b[^\n]*\bcommit\b', cmd) and EM_DASH in cmd:
    print('Blocked: the commit message contains an em dash. Use "-" instead (AGENTS.md).', file=sys.stderr)
    sys.exit(2)
