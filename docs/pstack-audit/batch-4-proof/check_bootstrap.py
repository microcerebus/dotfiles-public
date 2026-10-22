#!/usr/bin/env python3
"""Check missing-closure bootstrap with fake Nix/Java and stubbed model runs.

This fixture never contacts Nix or claims a TLC result. It failed on the
original runner before wrapper access was preceded by pinned realization.
Run from the repository root.
"""

import importlib.util
import json
import tempfile
from pathlib import Path

runner = Path('docs/pstack-audit/batch-4-proof/verify.py').resolve()
spec = importlib.util.spec_from_file_location('verify', runner)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
with tempfile.TemporaryDirectory(prefix='formal-tool-bootstrap-') as temp:
    here = Path(temp)
    # Only the runners before the nixpkgs pin read the root lock; keep it so the
    # original runner still fails here for its missing-closure reason.
    (here / "flake.lock").write_bytes((mod.ROOT / "flake.lock").read_bytes())
    mod.ROOT = here
    mod.HERE = here
    for name in ('Handoff.cfg', 'Handoff.tla'):
        (here / name).write_bytes((runner.parent / name).read_bytes())
    tool = here / 'tlaplus'
    java = here / 'zulu-ca-jdk-8.0.492/bin/java'
    calls = []
    def execute(command, **kwargs):
        calls.append(command)
        if command[:2] == ['nix', 'eval']:
            return 0, json.dumps({'revision': mod.NIXPKGS, 'system': 'aarch64-darwin', 'version': '1.7.4', 'tool': str(tool)}).encode()
        if command == mod.NIX_SHELL + ['true']:
            (tool / 'bin').mkdir(parents=True)
            (tool / 'bin/tlc').write_text(f'exec "{java}" -cp tla2tools.jar tlc2.TLC "$@"\n')
            return 0, b'pinned closure realized\n'
        if command == [str(java), '-version']:
            return 0, b'fixture runtime\n'
        raise AssertionError(f'Unexpected external call: {command}')
    mod.execute = execute
    mod.execute_split = lambda command, **kwargs: (*execute(command, **kwargs), b'')
    def case(output, name, source, model, invariants, spec='Spec'):
        (output / name).mkdir()
        return {'name': name, 'result': 'counterexample', 'exit': 12,
                'violated': invariants[0] if name.startswith('mutation-') else 'ProtectLocalRebuild'}
    mod.run_case = case
    try:
        result = mod.main()
    except FileNotFoundError:
        print('FAIL: runner read the unrealized TLC wrapper after nix eval; no nix shell ran')
        raise SystemExit(1)
    assert result == 12
    assert calls[1] == mod.NIX_SHELL + ['true']
    assert (here / 'evidence/tool-realization.exit').read_text() == '0\n'
    print('PASS: pinned nix shell realizes the missing closure before wrapper/runtime inspection')
