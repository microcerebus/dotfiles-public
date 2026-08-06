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
