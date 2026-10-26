# The text checks behind nix/activation-sudo.nix: activate text in, list of
# problems out. Kept apart so tests/activation_sudo_lint_test.nix can pin
# every rule on crafted lines (`nix flake check` runs it).
{ lib }:

rec {
  fnDef = ''sudo() { /usr/bin/sudo "$@"; }'';

  # Reads activate the way bash nests it, as logical lines: one per command
  # line, where `\` + newline is dropped and a newline inside quotes or an
  # expansion becomes a space. A real `$(` (not quoted, not escaped) starts
  # a logical line of its own, since bash parses what is inside as a new
  # command; the outer line keeps `$()` in its place. Comments are dropped,
  # and heredoc bodies are kept apart in `docs`.
  # Returns { lines = [ { i; l; depth; } ]; unread = [ { line; why; } ];
  # docs = [ { line; op; body; closed; } ] }, where i and line are 0-based
  # physical activate lines and depth counts the `$(` and `(` still open
  # where the line ends (0 at the top level). Braces are not tracked, so a
  # line inside `{ ...; }` or a function body has depth 0.
  scan = text:
    let
      nl = "\n";
      # Every character bash treats specially somewhere; the text between
      # tokens is plain in every mode.
      tokenRe = ''(\\.|\$'|\$\(\(|\$\(|\$\{|<<<|<<-?|\(\(|['"()}#`${nl}])'';
      # Modes: code, subst ($(...)), paren ((...)), dq, sq, ansi ($'...'),
      # param (${...}), array (x=(...), where a newline reads on), arith
      # and aparen ($((...)) and its parentheses).
      top = st: if st.modes == [ ] then "code" else (builtins.head st.modes).m;
      codeLike = m: m == "code" || m == "subst" || m == "paren";
      push = m: st: st // { modes = [{ inherit m; line = st.phys; }] ++ st.modes; };
      pop = st: st // { modes = builtins.tail st.modes; };
      add = s: st:
        let b = builtins.head st.bufs;
        in st // { bufs = [ (b // { cur = b.cur + s; }) ] ++ builtins.tail st.bufs; };
      unread = why: st: st // { unread = st.unread ++ [{ line = st.phys; inherit why; }]; };
      # A newline bash reads on past (quotes, expansions).
      space = st: add " " st // { phys = st.phys + 1; };
      # A newline that ends a command. It starts the pending heredoc bodies.
      entry = st: b: { i = b.start; l = b.cur; depth = builtins.length st.modes; };
      endLine = st:
        let
          b = builtins.head st.bufs;
          phys = st.phys + 1;
          st' = st // {
            inherit phys;
            done = st.done ++ [ (entry st b) ];
            bufs = [{ start = phys; cur = ""; }] ++ builtins.tail st.bufs;
          };
        in
        if st.pend == [ ] then st'
        else st' // {
          pend = map (d: d // { op = b.cur; }) st.pend;
          body = { cur = ""; text = ""; };
        };
      openSubst = st:
        let st' = push "subst" (add "$(" st);
        in st' // { bufs = [{ start = st.phys; cur = ""; }] ++ st'.bufs; };
      closeSubst = st:
        let b = builtins.head st.bufs;
        in pop (add ")" (st // {
          done = st.done ++ [ (entry st b) ];
          bufs = builtins.tail st.bufs;
        }));
      boundary = [ " " "\t" nl ";" "&" "|" "(" ")" "<" ">" ];

      # Heredocs. After `<<` the delimiter word is read (quotes and `\`
      # removed); the body runs from the next command-ending newline to a
      # line equal to the delimiter (leading tabs dropped for `<<-`).
      finishWord = st:
        let
          w = st.hw;
          delim = builtins.replaceStrings [ "'" "\"" "\\" ] [ "" "" "" ] w.raw;
          st' = st // { hw = null; };
        in
        if delim == "" then unread "a heredoc with no delimiter word" st'
        else st' // { pend = st.pend ++ [{ inherit delim; inherit (w) dash line; op = ""; quoted = delim != w.raw; }]; };
      gather = st: isTok: t:
        let
          w = st.hw;
          more = s: st // { hw = w // { raw = w.raw + s; }; };
          s = if w.raw == "" then builtins.head (builtins.match "[ \t]*(.*)" t) else t;
          m = builtins.match "([^[:space:];&|<>]*)(.*)" s;
        in
        if builtins.length st.modes > w.depth then more t
        else if builtins.elem t [ nl "(" "((" ")" "<<" "<<-" "<<<" ] then finishWord st
        else if isTok then more t
        else if builtins.elemAt m 1 == "" then more s
        else finishWord (more (builtins.head m));
      bodyLine = st:
        let
          d = builtins.head st.pend;
          l = if d.dash then builtins.head (builtins.match "[\t]*(.*)" st.body.cur) else st.body.cur;
          phys = st.phys + 1;
          rest = builtins.tail st.pend;
          st' = st // {
            inherit phys;
            pend = rest;
            docs = st.docs ++ [{ inherit (d) line op; body = st.body.text; closed = true; }];
          };
        in
        if l != d.delim then
          st // { inherit phys; body = st.body // { cur = ""; text = st.body.text + st.body.cur + nl; }; }
        else if rest != [ ] then st' // { body = { cur = ""; text = ""; }; }
        else st' // {
          body = null;
          bufs = [ (builtins.head st.bufs // { start = phys; }) ] ++ builtins.tail st.bufs;
        };
      inBody = st: t:
        if t == nl then bodyLine st
        # Bash joins `\` + newline before it looks for the delimiter, unless
        # the delimiter word was quoted.
        else if t == "\\${nl}" then
          (if (builtins.head st.pend).quoted
          then bodyLine (st // { body = st.body // { cur = st.body.cur + "\\"; }; })
          else st // { phys = st.phys + 1; })
        else st // { body = st.body // { cur = st.body.cur + t; }; };

      escape = st: t:
        let m = top st; c = lib.substring 1 1 t; in
        # Inside '...' a backslash is a plain character.
        if m == "sq" then token (add "\\" st) c
        else if c == nl then
          (if m == "ansi" then add "\\ " st else st) // { phys = st.phys + 1; }
        else add t st;
      plainText = st: t:
        # A `)` in a case pattern would close the $( or ( early. The word
        # never touches a `-` (--ignore-case is no case statement).
        if codeLike (top st)
          && builtins.any (x: x.m == "subst" || x.m == "paren") st.modes
          && builtins.match "(.*[^[:alnum:]_-])?case([^[:alnum:]_-].*)?" t != null
        then unread "a case statement inside $(...) or (...)" (add t st)
        else add t st;
      token = st: t:
        let m = top st; in
        if t == nl then (if codeLike m then endLine st else space st)
        else if lib.hasPrefix "\\" t then escape st t
        else if m == "sq" || m == "ansi" then
          (if t == "'" || t == "$'" then pop (add t st) else add t st)
        else if m == "dq" && builtins.elem t [ "\"" "'" "$'" ] then
          (if t == "\"" then pop (add t st) else add t st)
        else if t == "'" then push "sq" (add t st)
        else if t == "$'" then push "ansi" (add t st)
        else if t == "\"" then push "dq" (add t st)
        else if t == "$(" then openSubst st
        else if t == "$((" then push "aparen" (push "arith" (add t st))
        else if t == "\${" then push "param" (add t st)
        else if t == "`" then unread "a backtick substitution" (add t st)
        else if m == "dq" then add t st
        else if m == "param" then (if t == "}" then pop (add t st) else add t st)
        else if m == "arith" || m == "aparen" then
          (if t == "(" then push "aparen" (add t st)
          else if t == "((" then push "aparen" (push "aparen" (add t st))
          else if t == ")" then pop (add t st)
          else add t st)
        else if t == "#" && builtins.elem st.prev boundary then st // { comment = true; }
        else if t == "(" then push (if st.prev == "=" then "array" else "paren") (add t st)
        else if t == "((" then push "aparen" (push "arith" (add t st))
        else if t == ")" then
          (if m == "paren" || m == "array" then pop (add t st) else if m == "subst" then closeSubst st else add t st)
        else if t == "<<" || t == "<<-" then
          add t st // { hw = { dash = t == "<<-"; raw = ""; line = st.phys; depth = builtins.length st.modes; }; }
        else add t st;

      step = st: x:
        let
          isTok = builtins.isList x;
          t = if isTok then builtins.head x else x;
          st' = if st.hw == null then st else gather st isTok t;
          next = if isTok then token st' t else plainText st' t;
        in
        if t == "" then st
        else if st.body != null then inBody st t
        else if st.comment then
          # Inside x=( ... ) the newline after a comment reads on.
          (if t == nl || t == "\\${nl}"
          then (if codeLike (top st) then endLine else space) (st // { comment = false; prev = nl; })
          else st)
        else next // {
          # `\` + newline vanishes, so `x=y\` + `#...` is one word.
          prev = if t == "\\${nl}" then st.prev
            else if isTok && lib.hasPrefix "\\" t then "\\"
            else lib.substring (lib.stringLength t - 1) 1 t;
        };

      # builtins.foldl' forces only the state attrset, not its fields. A
      # field built from the last state's (phys + 1, cur + s, done ++ [ ... ])
      # would stay a thunk pointing at the one before, a chain as long as the
      # text, and forcing it at the end would recurse once per link: three
      # times today's activate overflowed Nix's max-call-depth. So each step
      # forces every field but the three growing lists, those lists' spines,
      # and their newest entries (whose thunks would keep an old state
      # alive). The depth then stays the same at any text length.
      strict = st:
        let newest = xs: if xs == [ ] then null else lib.last xs;
        in builtins.deepSeq
          [
            (removeAttrs st [ "done" "docs" "unread" ])
            (map newest [ st.done st.docs st.unread ])
          ]
          st;

      end = builtins.foldl' (st: x: strict (step st x))
        {
          modes = [ ];
          bufs = [{ start = 0; cur = ""; }];
          done = [ ];
          phys = 0;
          prev = nl;
          comment = false;
          unread = [ ];
          hw = null;
          pend = [ ];
          body = null;
          docs = [ ];
        }
        (builtins.split tokenRe text);
      end' = if end.hw == null then end else finishWord end;
      # At the end of the text, a body whose last line is the delimiter
      # (with no newline after it) is closed; any other pending one is not.
      last = if end'.body == null then end' else bodyLine end';
      open = if end'.body == null then end'.pend else last.pend;
    in
    {
      lines = last.done ++ map (entry last) last.bufs;
      unread = last.unread
        ++ lib.optional (last.modes != [ ]) { inherit (lib.last last.modes) line; why = "a quote, $( or ( it cannot pair"; };
      docs = last.docs ++ map (d: { inherit (d) line op; body = ""; closed = false; }) open;
    };

  # problems { prefix = config.homebrew.prefix; enable = config.homebrew.enable; text = <activate text>; }
  # gives [ { rule; text; } ]; rule names the check, text explains it.
  problems = { prefix, enable, text }:
    let
      s = scan text;
      numbered = s.lines;
      code = map (x: x.l) numbered;
      firstIndex = pred:
        let hits = map (x: x.i) (builtins.filter pred numbered);
        in if hits == [ ] then null else builtins.foldl' lib.min (builtins.head hits) hits;

      isDef = l: lib.trim l == fnDef;
      # Only a definition at the top level lasts: one inside ( ... ) dies
      # with the subshell.
      topDef = x: x.depth == 0 && isDef x.l;
      defIndex = firstIndex topDef;
      defCount = builtins.length (builtins.filter topDef numbered);
      # Any other definition of a sudo function, or an unset naming it.
      redefines = l: !(isDef l) && (
        builtins.match ''(.*[^[:alnum:]_])?(function[[:space:]]+sudo|sudo[[:space:]]*\(\)).*'' l != null
        || builtins.match ''(.*[^[:alnum:]_])?unset([[:space:]]+[^;&|[:space:]]+)*[[:space:]]+["']?sudo["']?([^[:alnum:]_-].*)?'' l != null);
      # Forms that skip functions. Each flag may take one argument
      # (`exec -a name sudo`).
      bypasses = l:
        builtins.match ''(.*[^[:alnum:]_])?(command|exec|builtin)[[:space:]]+(-[^[:space:]]+[[:space:]]+([^-[:space:]][^[:space:]]*[[:space:]]+)?)*sudo([^[:alnum:]_-].*)?'' l != null;

      # Every PATH=<homebrew prefix> on a line, with the text before it and
      # the text after it up to the next one. A backslash escape counts as a
      # boundary: a child shell reads the \n of $'...\nPATH=' or printf
      # as a newline.
      pathRe = ''(^|[^[:alnum:]_]|\\[[:alnum:]])(PATH=["']?${lib.escapeRegex prefix})'';
      matches = l:
        let
          parts = builtins.split pathRe l;
          str = g: if g == null then "" else g;
          render = x: if builtins.isList x then lib.concatMapStrings str x else x;
        in
        builtins.genList
          (k:
            let idx = 2 * k + 1;
            in {
              before = lib.concatMapStrings render (lib.sublist 0 idx parts)
                + str (builtins.head (builtins.elemAt parts idx));
              after = builtins.elemAt parts (idx + 1);
            })
          ((builtins.length parts - 1) / 2);
      # A prefix assignment this shell reads starts its logical line, which
      # is also the case right after a real `$(` (homebrewCleanupResult=$(
      # PATH=... under cleanup = "check"). Anywhere else it is an argument
      # (env PATH=...) or text a child shell runs (bash -c '...'), and that
      # program looks sudo up in PATH without the function.
      startsCommand = m: lib.trim m.before == "";
      # The command word after the assignment, and the words after it. An
      # unquoted value ends at a control character: `PATH=...; sudo` is a
      # plain assignment that stays set, with no command behind it.
      command = m:
        let w = builtins.match ''[^[:space:]"';&|<>()]*["']?[[:space:]]+([^[:space:]]+)(.*)'' m.after;
        in if w == null then { word = null; args = [ ]; } else {
          word = builtins.head w;
          args = builtins.filter (x: builtins.isString x && x != "") (builtins.split "[[:space:]]+" (builtins.elemAt w 1));
        };
      isSudo = m: builtins.elem (command m).word [ "sudo" "/usr/bin/sudo" ];
      # sudo's target user from its options (up to the first word that is
      # not one): the last --user=X, --user X, -u X or -uX, where -u may
      # follow -E, -H or -n in a cluster (-EHu X). Beside it only -E, -H,
      # -n, --preserve-env[=...], --set-home and --non-interactive are read.
      # null when there is no user, or any other option comes first: sudo
      # takes -p x or -g staff with an argument and --us=root as --user, so
      # guessing past them could miss a root.
      sudoUser = m:
        let
          unquote = builtins.replaceStrings [ "'" "\"" ] [ "" "" ];
          flags = [ "--preserve-env" "--set-home" "--non-interactive" ];
          read = st: w:
            let cluster = builtins.match "-[EHn]*u(.*)" w; in
            if st.stop then st
            else if st.want then st // { u = w; want = false; }
            else if w == "--" || !(lib.hasPrefix "-" w) then st // { stop = true; }
            else if w == "--user" then st // { want = true; }
            else if lib.hasPrefix "--user=" w then st // { u = lib.removePrefix "--user=" w; }
            else if builtins.elem w flags || lib.hasPrefix "--preserve-env=" w || builtins.match "-[EHn]+" w != null then st
            else if cluster == null then { u = null; want = false; stop = true; }
            else if builtins.head cluster == "" then st // { want = true; }
            else st // { u = builtins.head cluster; };
          end = builtins.foldl' read { u = null; want = false; stop = false; } (command m).args;
        in
        if end.want || end.u == null then null else unquote end.u;
      # A plain user name other than root: not empty, not a $variable, not
      # 0 or #0.
      dropsRoot = m:
        let u = sudoUser m;
        in u != null && builtins.match "[[:alnum:]_][[:alnum:]_.-]*" u != null && !(builtins.elem u [ "root" "0" ]);
      brewPathLine = l: matches l != [ ];
      notCommandStart = l: builtins.any (m: !(startsCommand m)) (matches l);
      notSudo = l: builtins.any (m: !(isSudo m)) (matches l);
      staysRoot = l: builtins.any (m: isSudo m && !(dropsRoot m)) (matches l);
      firstBrewPath = firstIndex (x: brewPathLine x.l);

      lineList = xs: lib.concatMapStringsSep ", " (x: "activate line ${toString (x.line + 1)}${lib.optionalString (x ? why) ": ${x.why}"}") xs;
      named = builtins.filter (d: lib.hasInfix prefix (d.op + d.body)) s.docs;
      unclosed = builtins.filter (d: !d.closed) s.docs;
      show = ls: lib.concatMapStrings (l: "\n    ${lib.trim l}") ls;
      rule = id: cond: text: lib.optional cond { rule = id; inherit text; };
    in
    rule "quote" (s.unread != [ ])
      "the activate script has text this lint cannot read (${lineList s.unread}), so it cannot tell which text a child program runs"
    ++ rule "heredoc" (named != [ ])
      "the activate script has a heredoc that names ${prefix} (${lineList named}); this lint does not read heredoc text"
    ++ rule "heredoc" (unclosed != [ ])
      "the activate script has a heredoc whose delimiter never appears (${lineList unclosed})"
    ++ rule "gone" (enable && firstBrewPath == null)
      "homebrew is enabled, but the activate script has no PATH=${prefix} line; check how nix-darwin now runs brew bundle (a store script runs without the sudo function, and this lint cannot see a prefix built from a variable)"
    ++ rule "count" (defCount != 1)
      "the activate script must define `${fnDef}` exactly once, outside any ( ... ) or $( ... ) (found ${toString defCount})"
    ++ rule "order" (defIndex != null && firstBrewPath != null && firstBrewPath < defIndex)
      "a command runs behind the Homebrew PATH before the sudo function is defined (activate line ${toString (firstBrewPath + 1)}, function at line ${toString (defIndex + 1)})"
    ++ rule "redefine" (builtins.any redefines code)
      "the activate script redefines or unsets sudo:${show (builtins.filter redefines code)}"
    ++ rule "bypass" (builtins.any bypasses code)
      "the activate script calls sudo past the function:${show (builtins.filter bypasses code)}"
    ++ rule "start" (builtins.any notCommandStart code)
      "the Homebrew PATH must start a command (its line, or right after `$(`), or another program looks sudo up there; a PATH= handed to env or a child shell fails even when that program runs as another user, since this lint cannot tell:${show (builtins.filter notCommandStart code)}"
    ++ rule "notSudo" (builtins.any notSudo code)
      "only sudo may run behind the Homebrew PATH as root:${show (builtins.filter notSudo code)}"
    ++ rule "user" (builtins.any staysRoot code)
      "sudo behind the Homebrew PATH must run its command as a named user other than root (--user=X or -u X, beside only -E, -H, -n, --preserve-env, --set-home or --non-interactive), or root looks that command up there:${show (builtins.filter staysRoot code)}";
}
