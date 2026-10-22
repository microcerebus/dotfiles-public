# Batch 4 formal verification generator

## Selection

Adopt-adapted: `create-formal-verification-skill`.
The [audited upstream source](https://github.com/cursor/plugins/blob/88d47514b82e7c44f00f2b2a72ff6dd12158038c/pstack/skills/create-formal-verification-skill/SKILL.md) is prompt-only Markdown from pstack 0.15.29.
Its license comes from [pstack/LICENSE at the same revision](https://github.com/cursor/plugins/blob/88d47514b82e7c44f00f2b2a72ff6dd12158038c/pstack/LICENSE), because the upstream skill directory has no separate license file.
The local directory retains that MIT license.
The fetched skill's SHA-256 is `6c934cd15a9583533ff9b7a9cad62775d7e80402d26d3ba7f74f79ea21a1d8eb`.
The license's SHA-256 is `bc957ca6bee02792566a1a028d105e02e247c6e77cf057061674273da77b200e`.

Keep its requirements for source mapping, bounded claims, counterexamples, reproducible reruns and a broken-source exercise.
The adaptation adds a pinned-tool gate and an explicit no-verifier result when formal checking does not earn its place.
The model must represent interleavable source steps separately and must not assume the property it claims to check.
Subject-code fixes remain separate work.

Preserve the upstream explicit-only policy for both harnesses.
A narrow poteto-mode route selects it for requests to model-check a race, prove an invariant or create a formal verification skill.
Ordinary bug fixes and reviews keep their existing routes.
This adds one canonical Claude declaration and one Codex alias in `nix/user.nix`.
The shared role adapter owns Codex-first model selection; the generator adds no provider-specific model names.
Generated project skills use the repository's established location, or `.agents/skills/verify-<area>/` when none exists.

`maintain-formal-verification-skill` remains pending for batch 5.
This batch does not install or invoke it.
The generated project skill records source coverage and the last checked source commit so batch 5 can assess drift.

## Tool provenance

The proof runner pins nixpkgs to `7a6522c868711d06e3a520bbcdfafe9806f4337f`, the root `flake.lock` value at review time.
Its NAR hash is `sha256-mN15cwddbOOIzzXSSwYUeRfOYeizz47Vy6y3Hzq6DuY=`.
The runner fetches that pin itself, so later flake updates do not move it; it uses no registry resolution or lockfile change.

- `pkgs.tlaplus` is package version 1.7.4.
  Its executable identifies itself as TLC 2.19.
  The [pinned derivation](https://github.com/NixOS/nixpkgs/blob/7a6522c868711d06e3a520bbcdfafe9806f4337f/pkgs/by-name/tl/tlaplus/package.nix) fetches `tla2tools.jar` from release v1.7.4 with hash `sha256-k2omIGHJFGlN/WaaVDviRXPEXVqg/yCouWsj0B4FDog=`.
- The derivation wraps TLC with `pkgs.jre8`.
  On `aarch64-darwin`, that resolves to Zulu JDK 8.0.492 from the same locked nixpkgs.
- Apalache is absent from this nixpkgs package set and is not used.

An authorized temporary `nix shell` fetched the closure from `cache.nixos.org` and ran TLC.
This populates the Nix store; it does not install a profile package, enable a service, or apply a system configuration.
No curl-to-shell, unpinned executable download, brew or global npm install ran.
The source review fetched only the frozen Markdown and license text.

## Proof and invocation evidence

The [project proof](batch-4-proof/README.md) returns **counterexample**.
Apply can sample revision A, a human rebuild can finish at unpushed L, and apply can then activate A from its stale decision.
A constrained witness has the human finish before the daemon invokes darwin-rebuild, so the finding does not depend on overlapping rebuild commands.
Source inspection supports that ordering; this was not a live activation experiment.
The updater is unchanged and a fix belongs to a separate unit.

The fetched-handoff and exact-selected-revision properties pass across 375,282 distinct states in the finite model.
All three scratch source/model mutations produce their intended invariant failures.
The restored baseline reproduces the rollback counterexample and returns TLC exit 12.
The parent rerun after integration returned the same results.
The [source map](batch-4-proof/source-map.md) lists every transition, bound, assumption and excluded behavior.

The [invocation proof](batch-4-route-proof.md) records the fresh project-generation context and the automatic route.
For a README heading requirement, a fresh read-only Astra session returned **no-verifier**, ran an ordinary check with two failing in-memory variants, and generated no skill.
That outcome is separate from the updater counterexample.
