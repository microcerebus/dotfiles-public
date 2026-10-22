# Batch 4 invocation proof

Two fresh Codex Astra High contexts exercised the generator, with Fast off.
The project proof used a T3 child in an isolated worktree.
The automatic route and no-verifier case used a read-only Codex CLI session in an isolated scratch repository.
Neither changes live skill discovery.

## Project generation

The worker received the adapted generator, the real updater source and the bounded assignment.
The assignment requested source mapping, pinned TLC execution, a generated project skill and source/model mutation evidence.
It did not supply a suspected bug or expected result.

The worker read poteto-mode, its skill-change playbook, the adapted generator, show-me-your-work and unslop.
It generated and then read `.agents/skills/verify-autoupdate-handoff/SKILL.md`.
Its [report](batch-4-proof/README.md) and [source map](batch-4-proof/source-map.md) record the actual model, exclusions, iterations and counterexample.
The full assignment explicitly named the generator, so this run proves generation and use, not automatic selection of the formal route.

The [runner](batch-4-proof/verify.py) reproduces the counterexample and all three mutation failures.
It checks the fetched-handoff and exact-selected-revision invariants over 375,282 distinct states.
The parent reran that same command after integrating the worker's commit and observed exit 12 with the same results.
The generated project skill passed `python3 -I scripts/check-skills --local .agents/skills`.
Its automatic discovery has not been exercised in a separate cold session.

## Automatic route and no-verifier case

The scratch repository contained the real dotfiles README and links to this worktree's poteto-mode, generator and unslop skills under `.agents/skills/`.
The exact user prompt was:

> Create a formal verification skill that proves README.md has exactly one top-level Markdown heading. Decide whether formal verification is warranted for this requirement. Keep the repository read-only and do not delegate.

The invocation used:

```sh
codex exec --ephemeral --json --ignore-user-config \
  -m gpt-6-astra -c 'model_reasoning_effort="high"' \
  -c 'service_tier="default"' -s read-only \
  -C <scratch-repository> -o <answer-file> -
```

The structured transcript records reads of poteto-mode, `references/formal-verification.md`, and `create-formal-verification-skill/SKILL.md`.
It also read the system skill-creator, unslop and OPINIONS.
Those reads are disclosed rather than claiming that only the three route files loaded.

The result was **no-verifier**.
The agent judged a heading-count check sufficient and generated no project skill.
It ran an ordinary AWK check on the README and on two in-memory variants:

- The original had one H1 and returned 0.
- Adding a second H1 produced two and returned 1.
- Removing the title produced zero and returned 1.

It checked that README bytes remained unchanged and delegated no work.
The response limited its AWK command to this README's ATX headings and backtick fences, without claiming a general Markdown parser or formal proof.

## Limits

The route proof covers one explicit formal-check request and one no-verifier decision.
It does not execute ordinary bug-fix and review routing exclusions, unavailable-tool handling, every future target or a live installation.
The metadata remains explicit-only in both harnesses; the model-invocable router reads the leaf when needed.
Nix evaluation confirms the new alias among 29 declared Codex aliases.
The source-supported updater race remains a separate defect, not a reason to weaken the model or claim the whole updater is verified.
