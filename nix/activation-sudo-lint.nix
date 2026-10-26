# The text checks behind nix/activation-sudo.nix: activate text in, list of
# problems out. Kept apart so tests/activation_sudo_lint_test.nix can pin
# every rule on crafted lines (`nix flake check` runs it).
{ lib }:

rec {
  fnDef = ''sudo() { /usr/bin/sudo "$@"; }'';

  # problems { prefix = config.homebrew.prefix; text = <activate text>; }
  problems = { prefix, text }:
    let
      lines = lib.splitString "\n" text;
      numbered = lib.imap0 (i: l: { inherit i l; }) lines;
      isCode = l: !(lib.hasPrefix "#" (lib.trim l));
      code = builtins.filter isCode lines;
      firstIndex = pred:
        let hits = builtins.filter (x: isCode x.l && pred x.l) numbered;
        in if hits == [ ] then null else (builtins.head hits).i;

      isDef = l: lib.trim l == fnDef;
      defIndex = firstIndex isDef;
      defCount = builtins.length (builtins.filter isDef code);
      # Any other definition of a sudo function, or an unset naming it.
      redefines = l: !(isDef l) && (
        builtins.match ''(.*[^[:alnum:]_])?(function[[:space:]]+sudo|sudo[[:space:]]*\(\)).*'' l != null
        || builtins.match ''(.*[^[:alnum:]_])?unset([[:space:]]+[^;&|[:space:]]+)*[[:space:]]+sudo([^[:alnum:]_-].*)?'' l != null);
      # Forms that skip functions. Each flag may take one argument
      # (`exec -a name sudo`).
      bypasses = l:
        builtins.match ''(.*[^[:alnum:]_])?(command|exec|builtin)[[:space:]]+(-[^[:space:]]+[[:space:]]+([^-[:space:]][^[:space:]]*[[:space:]]+)?)*sudo([^[:alnum:]_-].*)?'' l != null;

      # Every PATH=<homebrew prefix> on a line, with the text before it and
      # the text after it up to the next one.
      pathRe = ''(^|[^[:alnum:]_])(PATH=["']?${lib.escapeRegex prefix})'';
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
      # A prefix assignment this shell reads starts the trimmed line or
      # follows `$(` (homebrewCleanupResult=$(PATH=... under
      # cleanup = "check"). Anywhere else it is an argument (env PATH=...)
      # or text a child shell runs (bash -c '...'), and that program looks
      # sudo up in PATH without the function.
      startsCommand = m:
        let b = lib.trim m.before; in b == "" || lib.hasSuffix "$(" b;
      commandWord = seg:
        let m = builtins.match ''[^[:space:]"']*["']?[[:space:]]+([^[:space:]]+).*'' seg;
        in if m == null then null else builtins.head m;
      brewPathLine = l: matches l != [ ];
      notCommandStart = l: builtins.any (m: !(startsCommand m)) (matches l);
      notSudo = l:
        builtins.any (m: !(builtins.elem (commandWord m.after) [ "sudo" "/usr/bin/sudo" ])) (matches l);
      firstBrewPath = firstIndex brewPathLine;

      show = ls: lib.concatMapStrings (l: "\n    ${lib.trim l}") ls;
    in
    lib.optional (defCount != 1)
      "the activate script must define `${fnDef}` exactly once (found ${toString defCount})"
    ++ lib.optional (defIndex != null && firstBrewPath != null && firstBrewPath < defIndex)
      "a command runs behind the Homebrew PATH before the sudo function is defined (activate line ${toString (firstBrewPath + 1)}, function at line ${toString (defIndex + 1)})"
    ++ lib.optional (builtins.any redefines code)
      "the activate script redefines or unsets sudo:${show (builtins.filter redefines code)}"
    ++ lib.optional (builtins.any bypasses code)
      "the activate script calls sudo past the function:${show (builtins.filter bypasses code)}"
    ++ lib.optional (builtins.any notCommandStart code)
      "the Homebrew PATH must start a command (line start or right after `$(`), or another program looks sudo up there:${show (builtins.filter notCommandStart code)}"
    ++ lib.optional (builtins.any notSudo code)
      "only sudo may run behind the Homebrew PATH as root:${show (builtins.filter notSudo code)}";
}
