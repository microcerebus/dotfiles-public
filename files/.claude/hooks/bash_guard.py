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
4. Switching the system with a bare darwin-rebuild. It takes no lock, so
   the hourly auto-update could switch alongside it or replace it with a
   decision made before it (docs/formal/autoupdate-handoff). Switches go
   through `rebuild` and `rollback`, which hold the auto-update's switch
   lock. Only the command word counts, as for containers, also behind
   wrappers (sudo, timeout, caffeinate...) and reserved words (if, then,
   do, !, {...), across line continuations, through `nix run` of the
   nix-darwin flake, and inside sh/bash/zsh -c strings. Read-only actions
   (build, check, --list-generations, changelog) pass.
Exit 2 blocks the call and shows stderr to the agent. Unparseable commands
pass: this is a guardrail, not a sandbox."""
import json, os, re, shlex, sys, time

EM_DASH = '\N{EM DASH}'
CONTAINER_CMDS = {'docker', 'docker-compose', 'podman', 'colima', 'limactl', 'lima', 'orbctl', 'orb',
                  'multipass', 'vagrant'}
HARMLESS_ARGS = {'--version', '-v', 'version', '--help', '-h', 'help'}
APPROVAL = os.path.expanduser('~/.claude/containers-approved-until')
# A delimiter may hold - and . (<<'END-NOTES'); it starts with a letter so $((1<<2)) is no heredoc.
HEREDOC = re.compile(r"(?<!<)<<(?!<)-?\s*\\?(['\"]?)([A-Za-z_][^\s'\"<>;&|()]*)\1")
STILL_HOSTED = re.compile(r'(?i)\bstill (?:hosts|hosted (?:by|in)|running in)\b')  # same as write_guard.py
HANDOFF_TARGET = re.compile(r'>\s*\S*(?:/\.resume/|\.resume/|resume[^/\s]*$|resume[^/\s]*\s|/orchestrator/)')


def shell_code(cmd):
    """The command line without comments and heredoc bodies; both are data, not commands.
    A comment is an unquoted # at the start of a word, through the end of its line, so
    '#', \\#, ${#arr[@]}, x=a#b and flake refs like nix-darwin#darwin-rebuild stay text.
    Quotes and backslashes are tracked here because shlex has removed them by the time
    it yields a token, and an apostrophe inside a comment must not open a quote.
    "$(...)" opens unquoted code again, as in the shell, so a "$(cat <<'EOF' ...)"
    commit message body is dropped too. A backslash-newline outside single quotes joins
    the lines, as in the shell, so `darwin-rebuild \\<newline> switch` is one command."""
    out, i, n = [], 0, len(cmd)
    quote, parens, outer = None, 0, []  # outer: (quote, parens) around each "$(...)"
    word_start, pending = True, []
    while i < n:
        c = cmd[i]
        if quote == "'":
            if c == "'":
                quote = None
        elif c == '\\' and cmd.startswith('\n', i + 1):
            i += 2
            continue
        elif c == '\\':
            out.append(cmd[i:i + 2])
            i, word_start = i + 2, False
            continue
        elif quote == '"':
            if c == '"':
                quote = None
            elif cmd.startswith('$(', i):
                outer.append((quote, parens))
                quote, parens = None, 0
                out.append('$(')
                i, word_start = i + 2, True
                continue
        elif c in '\'"':
            quote = c
        elif c == '#' and word_start:
            j = cmd.find('\n', i)
            i = n if j < 0 else j
            continue
        elif c == '<' and (m := HEREDOC.match(cmd, i)):
            pending.append(m.group(2))
            out.append(m.group(0))
            i, word_start = m.end(), True
            continue
        elif c == '\n' and pending:
            out.append(c)
            i += 1
            for end in pending:
                while i < n:
                    j = cmd.find('\n', i)
                    line, i = (cmd[i:], n) if j < 0 else (cmd[i:j], j + 1)
                    if line.strip() == end:
                        break
            pending, word_start = [], True
            continue
        elif c == '(':
            parens += 1
        elif c == ')' and parens == 0 and outer:
            quote, parens = outer.pop()
        elif c == ')':
            parens = max(parens - 1, 0)
        out.append(c)
        word_start = quote is None and c in ' \t\r\n;&|()<>'
        i += 1
    return ''.join(out)


def segments(cmd):
    """Split a command line into simple commands on unquoted ; & | ( ) and newlines."""
    lex = shlex.shlex(shell_code(cmd), posix=True, punctuation_chars=';&|()\n')
    lex.whitespace = ' \t\r'
    lex.whitespace_split = True
    lex.commenters = ''  # shell_code already dropped them
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


SHELLS = {'sh', 'bash', 'zsh', 'dash', 'ksh'}


def all_segments(cmd, depth=0):
    """segments(), plus the segments of any `sh|bash|zsh -c '...'` script, recursively."""
    for seg in segments(cmd):
        yield seg
        script = shell_c_script(seg)
        if script is not None and depth < 3:
            try:
                yield from all_segments(script, depth + 1)
            except ValueError:
                pass


def shell_c_script(seg):
    """The script string of `sh|bash|zsh [options] -c script`, or None."""
    words = command_words(seg)
    if not words or os.path.basename(words[0]) not in SHELLS:
        return None
    it = iter(words[1:])
    for w in it:
        if w in ('-o', '+o', '-O', '+O'):
            next(it, None)
        elif re.fullmatch(r'-[a-zA-Z]*c[a-zA-Z]*', w):
            return next(it, None)
        elif not w.startswith(('-', '+')):
            return None
    return None


# Wrappers that run the next word as a command, with their flags that take a value.
WRAPPERS = {
    'sudo': {'-u', '-g', '-U', '-C', '-D', '-R', '-T', '-p', '-r', '-t', '--user', '--group',
             '--other-user', '--close-from', '--chdir', '--chroot', '--command-timeout', '--prompt',
             '--role', '--type'},
    'env': {'-u', '-C', '-P', '--unset', '--chdir'},
    'timeout': {'-s', '-k', '--signal', '--kill-after'},
    'caffeinate': {'-t', '-w'},
    'nice': {'-n'},
    'exec': {'-a'},
    'nohup': set(), 'time': set(), 'command': set(), 'builtin': set(),
}


# Reserved words that can come before a command word: `if cmd; then cmd; fi`, `{ cmd; }`, `! cmd`.
KEYWORDS = {'if', 'then', 'elif', 'else', 'do', 'while', 'until', '!', '{'}


def command_words(seg):
    """Drop reserved words, env assignments, wrappers and their flags before the command word."""
    words = [w.lstrip('`$') for w in seg]
    while words:
        if words[0] in KEYWORDS or re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*=.*', words[0]):
            words.pop(0)
            continue
        wrapper = os.path.basename(words[0])
        if wrapper not in WRAPPERS:
            break
        words.pop(0)
        while len(words) > 1 and words[0].startswith('-'):
            flag = words.pop(0)
            if flag == '--':
                break
            if wrapper == 'command' and flag in ('-v', '-V'):
                return []  # a lookup, not a run
            if flag in WRAPPERS[wrapper]:
                words.pop(0)
        if wrapper == 'timeout' and len(words) > 1:
            words.pop(0)  # the duration
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


SWITCH_ACTIONS = {'switch', 'activate', '--rollback', '--switch-generation', '-G'}


def runs_darwin_rebuild(word):
    """A flake installable that runs darwin-rebuild: <flake>#darwin-rebuild, or the
    nix-darwin flake itself, whose default package is darwin-rebuild."""
    flake, _, attr = word.partition('#')
    nix_darwin = 'nix-darwin' in re.split(r'[:/]', flake.split('?')[0])
    if attr:
        return re.fullmatch(r'(?:.*\.)?darwin-rebuild', attr) is not None or (nix_darwin and attr == 'default')
    return nix_darwin


def bare_switch(seg):
    """darwin-rebuild switching, activating or rolling back, directly or via nix run."""
    words = command_words(seg)
    if not words:
        return False
    head = os.path.basename(words[0])
    if head == 'nix' and 'run' in words:
        rest = words[words.index('run') + 1:]
        # The installable comes before `--`; words after it are the program's arguments.
        end = rest.index('--') if '--' in rest else len(rest)
        refs = [k for k, w in enumerate(rest[:end]) if not w.startswith('-') and runs_darwin_rebuild(w)]
        if not refs:
            return False
        words = rest[refs[0]:]
    elif head != 'darwin-rebuild':
        return False
    return any(w in SWITCH_ACTIONS or w.startswith('--switch-generation=') for w in words[1:])


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
    for line in shell_code(cmd).split('\n'):
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
    blocked = any(starts_container(s) for s in all_segments(cmd))
except ValueError:
    blocked = False
if blocked and not approved():
    print("Blocked: starting containers, OrbStack or VMs needs the owner's explicit OK (AGENTS.md). "
          'Reproduce Linux-only failures on a GitHub Actions run, or ask the owner.', file=sys.stderr)
    sys.exit(2)
try:
    switching = any(bare_switch(s) for s in all_segments(cmd))
except ValueError:
    switching = False
if switching:
    print('Blocked: a bare darwin-rebuild switch takes no lock, so the hourly auto-update can run alongside '
          'it or replace it. Ask the owner to run `rebuild` (or `rollback`, `rollback <n>` for a generation): '
          'these aliases wait for the switch lock. Read-only darwin-rebuild build, check and '
          '--list-generations pass (docs/formal/autoupdate-handoff).', file=sys.stderr)
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
