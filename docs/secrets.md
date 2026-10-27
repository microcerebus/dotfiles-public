# Secrets workflow

Rules (see AGENTS.md): per-device SSH keys, GitHub/GitLab access control does
the sharing. Never migrate private keys between machines. Never print/commit
secret material. Agents never touch ~/.ssh.

## Fresh-machine SSH setup (PLAN Phase 4, human runs the key steps)

```sh
ssh-keygen -t ed25519 -C "$(whoami)@$(scutil --get LocalHostName)"
gh auth login            # or paste the .pub key at github.com/settings/keys
ssh -T git@github.com    # expect the success greeting
```

macOS keychain integration in ~/.ssh/config:

```
Host *
  AddKeysToAgent yes
  UseKeychain yes
  IdentityFile ~/.ssh/id_ed25519
```

## Auto-update deploy key (root, read-only; human runs the key steps)

The root auto-update daemon (`scripts/dotfiles-autoupdate apply`, `nix/host.nix`) fetches GitHub's main into its own clone and builds only that.
It fetches with a read-only deploy key that only root can read, so nothing running as your user can choose what root builds.
The key never passes through your user or an agent.
Run these once per Mac:

```sh
sudo install -d -m 700 -o root -g wheel /var/lib/dotfiles-autoupdate
sudo ssh-keygen -t ed25519 -N '' -C "$(scutil --get LocalHostName) dotfiles-autoupdate (root, read-only)" -f /var/lib/dotfiles-autoupdate/deploy_key
sudo cat /var/lib/dotfiles-autoupdate/deploy_key.pub
```

Then on GitHub: microcerebus/dotfiles-public, Settings, Deploy keys, Add deploy key.
Paste the public key and leave "Allow write access" off.

Check: at the next ten past the hour, `dotfiles-autoupdate status` shows no switch alarm, and `/var/log/dotfiles-autoupdate.log` has a line `fetched GitHub main <revision>`.
Until the key exists, every hourly run alarms "there is no deploy key at /var/lib/dotfiles-autoupdate/deploy_key" and switches nothing.
Root's fetch, hourly and before each `rollback`, trusts only GitHub's host keys pinned in `nix/github-known-hosts` (the program sets them, `nix/autoupdate.nix`); if GitHub rotates them, update that file from GitHub's published fingerprints.
To rotate the deploy key, delete it on GitHub, then repeat the steps (`ssh-keygen` asks before it overwrites).

## Dashlane CLI (optional; Phase 0 decision)

If chosen: read the current official Dashlane CLI docs at setup time and verify
actual behavior interactively BEFORE writing any automation around it. Candidate
uses: injecting env secrets at runtime (`dcli exec` pattern) instead of .env
files. Document verified commands here once tested.

**Status 2026-07-05:** installed (`dashlane/tap/dashlane-cli` in `nix/host.nix`,
dcli 6.2614.0) but device registration is broken upstream: Dashlane moved their
device-registration/token-verification server endpoints in June 2026; the fix
(PR #399 "tokenVerification: use new endpoint structure") is merged but
unreleased. `dcli sync` fails with `verification_failed` until then.

**Update 2026-07-17:** the fix shipped as v6.2628.0 (2026-07-06; the planned
v6.2627.0 was skipped), together with PR #396 reworking the device-registration
and OTP2 login flows; latest is v6.2628.1. Human action: `rebuild` (brew
upgrades are now part of activation), then `dcli sync` (email code) - and
document verified commands here. No automation until that works.
