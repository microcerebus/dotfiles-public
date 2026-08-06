# no-mistakes (skill not included)

The real `SKILL.md` here is ~250 lines documenting
[`kunchenguid/no-mistakes`](https://github.com/kunchenguid/no-mistakes), the
validation-gate pipeline. It is upstream's documentation, so it is not
redistributed in this mirror.

The tool itself IS declared in this repo: `flake.nix` pins the release tag and
`nix/user.nix` builds it. Get the skill from upstream after a `rebuild`, then
run `no-mistakes init` per repo.

The directory is kept so `nix/user.nix`'s symlink into `~/.claude/skills/`
stays valid, and to show the pattern: tool skills are vendored into the repo
and linked out-of-store, so they are version-controlled alongside everything
else rather than living loose in `~/.claude/`.
