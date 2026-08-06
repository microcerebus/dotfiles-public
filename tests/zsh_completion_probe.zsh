#!/usr/bin/env zsh
# Headless zsh-completion probe: prints the candidates the completion system
# would offer for a given command line, one per line. This is what feeds
# fzf-tab's dropdown — if a candidate shows up here, it shows up in the menu.
#
# Usage:
#   tests/zsh_completion_probe.zsh 'brew install --cask fire'
#   PROBE_EXTRA_FPATH=/opt/homebrew/share/zsh/site-functions \
#     tests/zsh_completion_probe.zsh 'brew install --cask fire'
#
# fpath is built from the same Nix profile dirs the real zshrc uses, plus any
# colon-separated dirs in PROBE_EXTRA_FPATH. Runs completion functions only —
# read-only by construction (Enter is unbound in the captive shell), but note
# some completers shell out to list candidates (e.g. _brew runs `brew casks`).
#
# Adapted from Valodim/zsh-capture-completion (compadd-override technique).

emulate -L zsh
zmodload zsh/zpty || { print -u2 'error: zsh/zpty missing'; exit 1 }

(( $# )) || { print -u2 "usage: $0 'command line to complete'"; exit 1 }

typeset -g probe_dump=${TMPDIR:-/tmp}/zcompdump-probe-$$
export PROBE_EXTRA_FPATH

# captive interactive shell, no rc files
zpty z zsh -f -i

local line
() {
    zpty -w z "source $1"
    integer i
    for i in {1..50}; do
        zpty -r z line && [[ $line == *PROBE_READY* ]] && return 0
    done
    print -u2 'error: captive shell failed to initialize'
    zpty -d z
    exit 2
} =( <<< '
PROMPT="" RPROMPT=""

# same completion dirs the generated ~/.zshrc adds, plus extras under test
for p in ~/.nix-profile /etc/profiles/per-user/$USER \
         /run/current-system/sw /nix/var/nix/profiles/default; do
    [[ -d $p/share/zsh/site-functions ]] && fpath+=($p/share/zsh/site-functions)
done
fpath+=(${(s.:.)PROBE_EXTRA_FPATH})

autoload -Uz compinit
compinit -u -d '$probe_dump'

# never execute anything
bindkey "^M" undefined
bindkey "^J" undefined
bindkey "^I" complete-word

zstyle ":completion:*" list-grouped false
zstyle ":completion:*" insert-tab false
zmodload zsh/zutil

# markers around the completion dump
probe-mark-begin() { print -r -- __PROBE_BEGIN__ }
probe-mark-end()   { print -r -- __PROBE_END__ }
compprefuncs=( probe-mark-begin )
comppostfuncs=( probe-mark-end exit )

# hook: capture every compadd call and print its matches
compadd() {
    # internal bookkeeping calls pass straight through
    if [[ ${@[1,(i)(-|--)]} == *-(O|A|D)\ * ]]; then
        builtin compadd "$@"
        return $?
    fi
    typeset -a __hits __dscr __tmp
    if (( $@[(I)-d] )); then
        __tmp=${@[$@[(I)-d]+1]}
        if [[ $__tmp == \(* ]]; then
            eval "__dscr=$__tmp"
        else
            __dscr=( "${(@P)__tmp}" )
        fi
    fi
    builtin compadd -A __hits -D __dscr "$@"
    [[ -n $__hits ]] || return
    typeset -A apre hpre hsuf asuf
    zparseopts -E P:=apre p:=hpre S:=asuf s:=hsuf
    local i dscr
    for i in {1..$#__hits}; do
        (( $#__dscr >= i )) && dscr=$'\t'"${__dscr[$i]}" || dscr=
        print -r -- "$IPREFIX$apre$hpre$__hits[$i]$hsuf$asuf$dscr"
    done
}
print PROBE_READY
')

# type the command line and hit tab
zpty -w z "$1"$'\t'

# echo everything between the two marker lines
integer in_dump=0
while zpty -r z line; do
    line=${line%%$'\r'}
    if (( ! in_dump )); then
        [[ $line == *__PROBE_BEGIN__* ]] && in_dump=1
        continue
    fi
    [[ $line == *__PROBE_END__* ]] && break
    [[ -n ${line//[[:space:]]/} ]] && print -r -- $line
done

zpty -d z 2>/dev/null
rm -f $probe_dump{,.zwc} 2>/dev/null
