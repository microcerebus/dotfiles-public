# lavish (skill not included)

The real `SKILL.md` here is authored by **Kun Chen (kunchenguid)** and ships
with the `lavish-axi` CLI. It is not redistributed in this mirror.

To get it:

```sh
pnpm add -g lavish-axi
lavish-axi setup hooks
```

The directory is kept so `nix/user.nix`'s symlink into `~/.claude/skills/`
stays valid, and to show the pattern: tool skills are vendored into the repo
and linked out-of-store, so they are version-controlled alongside everything
else rather than living loose in `~/.claude/`.
