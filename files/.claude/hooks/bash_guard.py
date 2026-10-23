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
Exit 2 blocks the call and shows stderr to the agent. A command the guard cannot
read is blocked too: a heredoc delimiter word it cannot read, a reading that
fails, too many unclosed quotes, a command too long to read within the work
budget, or a bug in the guard. It is still a guardrail, not a sandbox: eval,
xargs and the like pass."""
import collections, functools, json, os, re, shlex, sys, time

EM_DASH = '\N{EM DASH}'
CONTAINER_CMDS = {'docker', 'docker-compose', 'podman', 'colima', 'limactl', 'lima', 'orbctl', 'orb',
                  'multipass', 'vagrant'}
HARMLESS_ARGS = {'--version', '-v', 'version', '--help', '-h', 'help'}
APPROVAL = os.path.expanduser('~/.claude/containers-approved-until')
# A heredoc operator; the delimiter word after it is read by heredoc_word().
HEREDOC = re.compile(r'(?<!<)<<(?!<)(-?)(?:[ \t]|\\\n)*')
# A delimiter word starts with anything but a blank, a metacharacter or # (<<'-EOF', <<\1, <<1).
# Inside (( )), $(( )), $[ ] or a bash a[ ] subscript a << is a shift instead: see in_arithmetic().
# Inside ${ } it is pattern text (${x#<<}): read_once() does not look for heredocs there.
WORD_START = re.compile(r'[^\s;&|()<>#]')
QUOTED = re.compile(r"'[^']*'|\"[^\"]*\"")
SUBSCRIPT = re.compile(r'[A-Za-z_][A-Za-z0-9_]*\[')
ASSIGNMENT = re.compile(r'[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=\S*')
CASE_WORD = re.compile(r'(case|esac)(?=[\s;&|)]|$)')
BASH_PREFIX_WORDS = {'if', 'then', 'elif', 'else', 'do', 'while', 'until', '!', '{', 'time', 'coproc'}
MAX_PASSES = 32  # read_script() passes before it gives up on a command
WORK_LIMIT = 3_000_000  # characters the guard may scan per call: about 2 s of CPU on Python 3.9
# Not charged: joining a heredoc body's backslash-newline lines (read_bodies), 12 s for 900 KB of them.
STILL_HOSTED = re.compile(r'(?i)\bstill (?:hosts|hosted (?:by|in)|running in)\b')  # same as write_guard.py
HANDOFF_TARGET = re.compile(r'>\s*\S*(?:/\.resume/|\.resume/|resume[^/\s]*$|resume[^/\s]*\s|/orchestrator/)')
# The guard reads a command once per shell and blocks if any reading would. The readings differ in
# where a heredoc body ends (read_bodies), in a << after a[ (in_arithmetic), and in ' inside "${ }"
# and a case inside $( ) (read_once). zsh is the login shell here, bash is bash 5 and bash3 is
# macOS /bin/bash 3.2.
READINGS = ('zsh', 'bash', 'bash3')


class Unreadable(Exception):
    """A command the guard cannot read the way a shell would. The hook blocks it with this message."""


work_left = WORK_LIMIT


def spend(k):
    """Charge k characters of scanning to the work budget. A command that needs more is Unreadable,
    so the hook answers well inside its 5 s timeout whatever the input."""
    global work_left
    work_left -= k
    if work_left < 0:
        raise Unreadable('the command is too long or too tangled for the guard to read in time. Split it, '
                         'or move long text into a file.')


def heredoc_word(cmd, i):
    """(delimiter, quoted, end) for the delimiter word at cmd[i], or None if the guard cannot
    read it as the shell does. The shell removes quotes and backslashes (<<E"OF", <<\\E\\OF and
    <<EO\\<newline>F all end at EOF) and a quoted word stops body expansion. Words with $'',
    $"", ${, $( or a backtick are not read: the hook blocks those heredocs (Unreadable)."""
    if not WORD_START.match(cmd, i):
        return None
    out, quoted, n = [], False, len(cmd)
    while i < n:
        c = cmd[i]
        if c == '\\' and cmd.startswith('\n', i + 1):
            i += 2
        elif c == '\\' and i + 1 < n:
            out.append(cmd[i + 1])
            i, quoted = i + 2, True
        elif c == "'":
            j = cmd.find("'", i + 1)
            if j < 0:
                return None
            out.append(cmd[i + 1:j])
            i, quoted = j + 1, True
        elif c == '"':
            i, quoted = i + 1, True
            while i < n and cmd[i] != '"':
                if cmd[i] == '\\' and cmd[i + 1:i + 2] in ('$', '`', '"', '\\', '\n'):
                    out.append(cmd[i + 1].strip('\n'))
                    i += 2
                elif cmd[i] == '`' or cmd.startswith(('$(', '${'), i):
                    return None
                else:
                    out.append(cmd[i])
                    i += 1
            if i == n:
                return None
            i += 1
        elif c in ' \t\n;&|()<>':
            break
        elif c in '\\`' or cmd.startswith(('$(', '${', "$'", '$"'), i):
            return None
        else:
            out.append(c)
            i += 1
    return ''.join(out), quoted, i


def line_before(cmd, i):
    """The text before cmd[i] on its line, with lines joined by a backslash-newline."""
    j = cmd.rfind('\n', 0, i)
    while j > 0 and cmd[j - 1] == '\\':
        j = cmd.rfind('\n', 0, j - 1)
    spend(i - j)
    return cmd[j + 1:i].replace('\\\n', '')


def in_arithmetic(text, sh):
    """Whether a << after text (line_before) is a shift: inside (( )), $(( )) or $[ ] in every
    shell, and in bash inside an a[ ] subscript that starts the command word (a[1<<2]=3, also
    after ;, |, (, if, !, time, time -p, time -p -- or assignments, and in bash 5 after coproc).
    bash reads echo x[ <<E and s/a[ <<E as heredocs, and zsh reads a << after a[ as a heredoc
    wherever it is. Where the guard cannot tell whether an unclosed a[ starts the command word,
    as after coproc and another word (bash 5 reads coproc foo a[ as an assignment), the command
    is Unreadable."""
    code = QUOTED.sub('', text)
    if code.count('((') > code.count('))') or code.rfind('$[') > code.rfind(']'):
        return True
    if sh == 'zsh':
        return False
    close = code.rfind(']')
    m = next((m for m in SUBSCRIPT.finditer(code) if m.end() - 1 > close), None)
    if m is None:
        return False
    head = re.split(r'[;&|(]', code[:m.start()])[-1]
    if head and head[-1] not in ' \t':
        return False  # inside a word, as in s/a[
    prefix = BASH_PREFIX_WORDS - {'coproc'} if sh == 'bash3' else BASH_PREFIX_WORDS  # bash 3.2 has no coproc
    words, timed, coproc = head.split(), False, False  # timed: just after time, where bash skips -p and --
    while words and (words[0] in prefix or ASSIGNMENT.fullmatch(words[0]) or timed and words[0] in ('-p', '--')):
        w = words.pop(0)
        timed, coproc = w == 'time' or timed and w in ('-p', '--'), coproc or w == 'coproc'
    if not words:
        return True
    if coproc or re.search(r'[$`\'"\\{}<>)#\[\]]', head):
        raise Unreadable('the guard cannot tell whether this << is a heredoc or a shift in an a[ ] subscript. '
                         'Quote the [ or put the heredoc on its own line.')
    return False


def bash3_match(cmd, k, end, frames):
    """Run bash 3.2's $( ) matcher over cmd[k:end]: the index of the ) that closes the $( ), or None.
    bash 3.2 finds the end of a $( ) before it reads any heredoc, so it scans a body as code. It
    skips '...', "...", $'...', `...`, backslash-escaped characters and a # comment after a blank,
    and matches ( with ). Inside "..." a ${ runs to its first }, and quotes inside it count.
    frames holds (kind, index) for what is still open when the scan stops, so the next body and
    the code after the last one start in that state, as in bash 3.2."""
    spend(end - k)
    while k < end:
        c, top = cmd[k], frames[-1][0] if frames else None
        if top == '#':
            if c == '\n':
                frames.pop()
        elif top == "'":
            if c == "'":
                frames.pop()
        elif c == '\\':
            k += 1
        elif top == '${':
            if c == '}':
                frames.pop()
            elif cmd.startswith('$(', k):
                frames.append(('$(', k + 1))
                k += 1
            elif c in '\'"`':
                frames.append((c, k))
        elif top in ('"', "$'", '`'):
            if c == top[-1]:
                frames.pop()
            elif top == '"' and cmd.startswith(('$(', '${'), k):
                frames.append((cmd[k:k + 2], k + 1))
                k += 1
            elif top == '"' and c == '`':
                frames.append(('`', k))
        elif c == '#' and cmd[k - 1] in ' \t\n':
            frames.append(('#', k))
        elif cmd.startswith("$'", k):
            frames.append(("$'", k + 1))
            k += 1
        elif c in '\'"`':
            frames.append((c, k))
        elif c == '(':
            frames.append(('$(' if cmd[k - 1] == '$' else '(', k))
        elif c == ')':
            if not frames:
                return k
            frames.pop()
        k += 1
    return None


def read_bodies(cmd, i, pending, sh, bodies):
    """Skip the bodies of the heredocs opened on the line before cmd[i], as shell sh reads them.
    Return (where commands resume, bash 3.2 matcher frames still open there). Commands resume at
    the start of the line after the last body, or at the point inside a body line where sh closes
    the $( ) or `...` around the heredoc first.
    Every reading ends a body on its first line equal to the delimiter, as the shell does.
    After <<- a line also ends it once its leading tabs are dropped (zsh drops the delimiter's
    too), and a line ending in an odd run of backslashes joins the next before the comparison
    after an unquoted delimiter, inside backticks, and for bash 3.2 inside $( ). Inside $( ), bash
    also ends it at a line that starts
    with the delimiter and holds a ) later, and bash 3.2 at the ) its matcher closes the $( )
    with (bash3_match). Inside backticks, both bash readings end it at an unescaped backtick."""
    n, frames = len(cmd), []
    for h in pending:
        start = i
        joins = not h.quoted or h.backtick or sh == 'bash3' and h.comsub
        while i < n:
            line_start = i
            j = cmd.find('\n', i)
            i = n if j < 0 else j + 1
            while joins and j >= 0 and (j - line_start - len(cmd[line_start:j].rstrip('\\'))) % 2:
                j = cmd.find('\n', i)
                i = n if j < 0 else j + 1
            raw = cmd[line_start:i].removesuffix('\n')
            cut = bash3_match(cmd, line_start, i, frames) if sh == 'bash3' and h.comsub else None
            if cut is not None:
                bodies.append((h.opener, cmd[start:cut]))
                return cut, []
            line = raw.replace('\\\n', '') if joins else raw
            if line == h.delim or h.dash and line.lstrip('\t') == (h.delim.lstrip('\t') if sh == 'zsh' else h.delim):
                bodies.append((h.opener, cmd[start:line_start]))
                break
            if sh != 'zsh' and h.backtick:
                tick = re.search(r'(?<!\\)(?:\\\\)*`', raw)
                cut = tick and line_start + tick.end() - 1
            if cut is None and sh == 'bash' and h.comsub and '\\\n' not in raw:
                tabs = len(raw) - len(raw.lstrip('\t')) if h.dash else 0
                if raw.startswith(h.delim, tabs) and ')' in raw[tabs + len(h.delim):]:
                    cut = line_start + tabs + len(h.delim)
            if cut is not None:
                bodies.append((h.opener, cmd[start:cut]))
                return cut, []
        else:
            bodies.append((h.opener, cmd[start:]))
    return i, [f for f in frames if f[0] != '#']


Heredoc = collections.namedtuple('Heredoc', 'delim dash quoted comsub backtick opener depth ticks')
# A "$( )", "${ }", $( ) inside "${ }" or `...` that read_once is inside: kind ('"$(', '"${', '$(' or
# '`'), the index to read as a literal if it never closes, and the state around it.
Frame = collections.namedtuple('Frame', 'kind at quote quote_at parens out')


@functools.lru_cache(maxsize=None)
def read_script(cmd, sh='zsh'):
    """(code, heredoc bodies, texts) of a command line as shell sh reads it.
    code is the command line without comments and heredoc bodies; both are data, not commands.
    A comment is an unquoted # at the start of a word, through the end of its line (inside
    `...`, through the closing backtick if that comes first), so
    '#', \\#, ${#arr[@]}, x=a#b and flake refs like nix-darwin#darwin-rebuild stay text.
    Quotes and backslashes are tracked here because shlex has removed them by the time
    it yields a token, and an apostrophe inside a comment must not open a quote.
    "$(...)" and `...` open unquoted code again, as in the shell, so a "$(cat <<'EOF' ...)"
    commit message body is dropped too. Their code moves to lines of its own after the rest,
    and the word keeps a $() in its place, because shlex cannot split quotes nested
    inside a quoted word: so `echo "$(docker ps)"` names docker as a command, and a
    commit message around a $(...) stays one word. "${...}" keeps a ${} in its place, so its
    nested quotes ("${x#"<<"}") do not end the outer ones. Its text is not code, but a $( )
    or `...` inside it is. zsh reads ' and $' inside "${...}" as literal characters, bash as
    quotes. A backslash-newline outside single quotes joins the lines, as in the shell, so
    `darwin-rebuild \\<newline> switch` is one command, and a lone backslash at the end is a
    literal one. $'...' ends at its first unescaped '.
    A quote still open at the end, as when the guard reads an unread heredoc body as code
    and meets an apostrophe there, is read again as a literal character, so it cannot hide
    the commands after it. After MAX_PASSES such passes the guard gives up (Unreadable).
    A quote that bash 3.2's matcher opened inside a body and never closes stays a quote:
    bash 3.2 rejects the command there, so nothing after it runs. bodies holds
    (line with the <<, body) pairs, and texts the text inside each "$( )", "${ }" and `...`,
    which the message checks read too.
    A case statement's pattern ) closes nothing in the zsh and bash readings where at_command()
    finds the case (not after time -p); bash 3.2 closes a $( ) there. The guard does not read
    bash 5.3's ${ cmd; } and ${| cmd; }, nested backticks, a backslash before `, \\ or $ inside
    `...`, or any backslash in a # comment there: those commands are Unreadable."""
    for _ in range(MAX_PASSES):
        code, bodies, texts, open_at = read_once(cmd, sh)
        if open_at is None:
            return code, tuple(bodies), tuple(texts)
        cmd = cmd[:open_at] + '\\' + cmd[open_at:]
    raise Unreadable('the command has too many unclosed quotes for the guard to read. Close them, '
                     'or move long text into a file.')


def not_funsub(cmd, i):
    """Raise Unreadable for bash 5.3's ${ cmd; } or ${| cmd; } at cmd[i]: commands the guard does not read."""
    if cmd[i + 2:i + 3] in (' ', '\t', '\n', '|'):
        raise Unreadable("the guard does not read bash 5.3's ${ cmd; } command substitution. Use $( ) instead.")


def at_command(out):
    """Whether code ending in out is where a command word goes: after ; & | ( or a newline, and any
    reserved words. A command more than 64 pieces long is past it."""
    tail = ''.join(out[-64:])
    k = max(tail.rfind(c) for c in ';&|(\n')
    return (k >= 0 or len(out) <= 64) and all(w in BASH_PREFIX_WORDS for w in tail[k + 1:].split())


def read_once(cmd, sh):
    """One pass of read_script: (code, bodies, texts, index of a quote left open or None)."""
    spend(len(cmd))
    out, bodies, chunks, i, n = [], [], [], 0, len(cmd)  # chunks: (kind, text) of each closed Frame
    quote, quote_at, parens, outer = None, None, [], []  # parens: '(', '$(', '${' or '"${' per open one
    word_start, pending, carried, ticks = True, [], set(), 0  # ticks: open `...` Frames

    def push(kind, at):
        nonlocal quote, parens, out, ticks
        out.append('${}' if kind == '"${' else '$()')
        outer.append(Frame(kind, at, quote, quote_at, parens, out))
        quote, parens, out, ticks = None, ['"${'] if kind == '"${' else [], [], ticks + (kind == '`')

    def pop():
        nonlocal quote, quote_at, parens, out, ticks
        f = outer.pop()
        chunks.append((f.kind, ''.join(out)))
        quote, quote_at, parens, out, ticks = f.quote, f.quote_at, f.parens, f.out, ticks - (f.kind == '`')

    def open_comsub():  # a $( ) in code: a Frame inside "${ }", whose text is not code, else inline
        if parens and parens[0] == '"${':
            push('$(', outer[-1].at)
        else:
            parens.append('$(')
            out.append('$(')

    def depth():  # open $( ), <( ) and `...`: a newline reads the heredocs opened this deep or deeper
        spend(len(outer))
        return sum(f.kind != '"${' for f in outer) + parens.count('$(') + sum(f.parens.count('$(') for f in outer)

    while i < n:
        c = cmd[i]
        top = outer[-1].kind if outer else None
        brace = bool(parens) and parens[-1] in ('${', '"${')
        zsh_dq = sh == 'zsh' and top == '"${'  # zsh reads ' and $' as literal characters here
        if ticks and (c == '`' and top != '`' or c == '\\' and cmd.startswith(('\\`', '\\\\', '\\$'), i)):
            raise Unreadable('the guard cannot read nested backticks, or a backslash before `, \\ or $ inside '
                             '`...`. Use $( ) instead.')
        if c == '`' and top == '`':  # the shell ends `...` at its first unescaped backtick, quoted or not
            pop()
            i, word_start = i + 1, False
            continue
        if quote == "'":
            if c == "'":
                quote = None
        elif quote == "$'":  # emitted as a '...' string, with \' as '"'"'
            if c == '\\':
                out.append('\'"\'"\'' if cmd.startswith("'", i + 1) else cmd[i:i + 2])
                i += 2
                continue
            if c == "'":
                quote = None
        elif c == '\\' and cmd.startswith('\n', i + 1):
            i += 2
            continue
        elif c == '\\':
            out.append(cmd[i:i + 2] if i + 1 < n else '\\\\')
            i, word_start = i + 2, False
            continue
        elif c == '`':
            push('`', i)
            i, word_start = i + 1, True
            continue
        elif quote == '"':
            if c == '"':
                quote = None
            elif cmd.startswith(('$(', '${'), i):
                brace_open = cmd[i + 1] == '{'
                if brace_open:
                    not_funsub(cmd, i)
                push('"${' if brace_open else '"$(', quote_at)
                i, word_start = i + 2, not brace_open
                continue
        elif cmd.startswith("$'", i) and not zsh_dq:
            quote, quote_at = "$'", i + 1
            out.append("'")
            i += 2
            continue
        elif c == '"' or c == "'" and not zsh_dq:
            quote, quote_at = c, i
        elif cmd.startswith('${', i):
            not_funsub(cmd, i)
            parens.append('${')
            out.append('${')
            i, word_start = i + 2, False
            continue
        elif brace:
            if c == '}' and parens.pop() == '"${':
                pop()
                i, word_start = i + 1, False
                continue
            elif cmd.startswith('$(', i):
                open_comsub()
                i, word_start = i + 2, True
                continue
        elif c == '#' and word_start:
            j = cmd.find('\n', i)
            j = n if j < 0 else j
            if ticks:  # the shell cuts out `...` before it reads the comment, so it ends at the backtick
                k = cmd.find('`', i, j)
                if '\\' in cmd[i:j if k < 0 else k]:
                    raise Unreadable('the guard cannot read a backslash in a # comment inside `...`. '
                                     'Use $( ) instead.')
                j = j if k < 0 else k
            i = j
            continue
        elif word_start and sh != 'bash3' and (w := CASE_WORD.match(cmd, i)) \
                and (w[1] == 'case' or parens[-1:] == ['case']) and at_command(out):
            if w[1] == 'case':  # a pattern's ) inside it closes nothing (bash 3.2's matcher does close a $( ) there)
                parens.append('case')
            else:
                parens.pop()
            out.append(w[1])
            i, word_start = i + 4, False
            continue
        elif c == '<' and (m := HEREDOC.match(cmd, i)) and WORD_START.match(cmd, m.end()) \
                and not in_arithmetic(line_before(cmd, i), sh):
            word = heredoc_word(cmd, m.end())
            if word is None or not word[0] and not word[1]:
                raise Unreadable('the guard cannot read this heredoc delimiter, so it cannot tell where the '
                                 "body ends. Use a plain delimiter such as <<'EOF' or <<EOF.")
            delim, quoted, end = word
            line_end = cmd.find('\n', i)
            opener = cmd[cmd.rfind('\n', 0, i) + 1:n if line_end < 0 else line_end]
            spend(len(opener))
            comsub = '$(' in parens or any(f.kind in ('"$(', '$(') or '$(' in f.parens for f in outer)
            pending.append(Heredoc(delim, m.group(1) == '-', quoted, comsub, ticks > 0, opener, depth(), ticks))
            out.append(cmd[i:end].replace('\\\n', ''))
            i, word_start = end, True
            continue
        elif c == '\n' and pending and (ready := [h for h in pending if h.depth >= (d := depth())]):
            spend(len(pending))
            out.append(c)
            pending = [h for h in pending if h.depth < d]
            # A heredoc whose $( ) closed on its own line has no body for zsh and bash 3.2, and one
            # in closed backticks has none for any shell; bash 5 reads the rest first.
            ready = sorted((h for h in ready if h.depth == d or sh == 'bash' and h.ticks <= ticks), key=lambda h: -h.depth)
            i, frames = read_bodies(cmd, i + 1, ready, sh, bodies)
            word_start = True
            for kind, at in frames:  # bash 3.2 is still inside these after the last body
                if kind == '`':
                    push('`', at)
                elif kind in ('(', '$(', '${') and quote:
                    push('"${' if kind == '${' else '"$(', quote_at)
                elif kind in ('(', '$('):
                    open_comsub()
                elif kind == '${':
                    parens.append(kind)
                    out.append(kind)
                else:
                    quote, quote_at = kind[-1], at
                    carried.add(at)
                    out.append(quote)
            continue
        elif c == '(':
            parens.append('$(' if cmd[i - 1:i] in ('$', '<', '>') else '(')
        elif c == ')' and parens[-1:] == ['case']:
            pass
        elif c == ')' and not parens and top in ('"$(', '$('):
            pop()
            i, word_start = i + 1, False
            continue
        elif c == ')' and parens:
            parens.pop()
        out.append(c)
        word_start = quote is None and not brace and c in ' \t\r\n;&|()<>'
        i += 1
    if quote and quote_at in carried:
        out.append(quote)
        quote = None
    open_at = quote_at if quote else outer[-1].at if outer else None
    code = ''.join(out) + ''.join('\n' + text for kind, text in chunks if kind != '"${')
    return code, bodies, [text for _, text in chunks], open_at


def shell_code(cmd, sh='zsh'):
    return read_script(cmd, sh)[0]


def segments(cmd, sh='zsh'):
    """Split a command line into simple commands on unquoted ; & | ( ) and newlines."""
    yield from split_segments(cmd, sh)


@functools.lru_cache(maxsize=None)
def split_segments(cmd, sh):
    code = shell_code(cmd, sh)
    spend(3 * len(code))  # shlex is slower per character than read_once
    lex = shlex.shlex(code, posix=True, punctuation_chars=';&|()\n')
    lex.whitespace = ' \t\r'
    lex.whitespace_split = True
    lex.commenters = ''  # shell_code already dropped them
    segs, seg = [], []
    for tok in lex:
        if tok and set(tok) <= set(';&|()\n'):
            if seg:
                segs.append(tuple(seg))
            seg = []
        else:
            seg.append(tok)
    if seg:
        segs.append(tuple(seg))
    return tuple(segs)


SHELLS = {'sh', 'bash', 'zsh', 'dash', 'ksh'}


def all_segments(cmd, sh='zsh', depth=0):
    """segments(), plus the segments of any `sh|bash|zsh -c '...'` script, recursively."""
    for seg in segments(cmd, sh):
        yield seg
        script = shell_c_script(seg)
        if script is not None and depth < 3:
            yield from all_segments(script, sh, depth + 1)


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
        if words[0] in KEYWORDS or re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=.*', words[0]):
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
    """Yield (line with the <<, body) for each heredoc, as any of READINGS reads it."""
    seen = []
    for sh in READINGS:
        for body in read_script(cmd, sh)[1]:
            if body not in seen:
                seen.append(body)
                yield body


def any_segment(test, cmd):
    """Whether test() holds for a simple command of cmd in any of READINGS. A reading that shlex
    cannot split is Unreadable: the commands it would find there are unknown."""
    for sh in READINGS:
        try:
            if any(test(s) for s in all_segments(cmd, sh)):
                return True
        except ValueError as e:
            raise Unreadable(f'the guard cannot split this command into commands ({e}).') from e
    return False


def commit_messages(cmd, cwd):
    """Every piece of commit message text in a command line, in any of READINGS. A message that
    holds a $( ), ${ } or `...` brings the text inside each of them along."""
    for opener, body in heredoc_bodies(cmd):
        if GIT_COMMIT_LINE.search(opener):
            yield body
    for sh in READINGS:
        try:
            segs = list(segments(cmd, sh))
        except ValueError:
            continue
        for seg in segs:
            for kind, value in message_parts(commit_args(seg) or []):
                if kind == 'text':
                    yield value
                    if '()' in value or '{}' in value:  # command_words() drops a leading $
                        yield from read_script(cmd, sh)[2]
                elif value != '-':
                    try:
                        yield open(os.path.join(cwd, os.path.expanduser(value))).read()
                    except OSError:
                        pass


def handoff_writes(cmd):
    """Text written into a resume note or orchestrator file: heredoc bodies and echo/printf lines,
    with the text inside any $( ), ${ } or `...` on such a line."""
    for opener, body in heredoc_bodies(cmd):
        if HANDOFF_TARGET.search(opener + ' '):
            yield body
    for sh in READINGS:
        code, _, texts = read_script(cmd, sh)
        for line in code.split('\n'):
            if re.search(r'(^|[\s;&|(])(echo|printf)\s', line) and HANDOFF_TARGET.search(line + ' '):
                yield line
                if '$()' in line or '${}' in line:
                    yield from texts


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
    if any_segment(starts_container, cmd) and not approved():
        print("Blocked: starting containers, OrbStack or VMs needs the owner's explicit OK (AGENTS.md). "
              'Reproduce Linux-only failures on a GitHub Actions run, or ask the owner.', file=sys.stderr)
        sys.exit(2)
    if any_segment(bare_switch, cmd):
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
except Unreadable as e:
    print(f'Blocked: {e} (bash_guard.py)', file=sys.stderr)
    sys.exit(2)
except Exception as e:  # a guard bug must not let the command through
    print(f'Blocked: bash_guard.py failed on this command ({type(e).__name__}: {e}). Split it into '
          'simpler commands, and report the failure.', file=sys.stderr)
    sys.exit(2)
