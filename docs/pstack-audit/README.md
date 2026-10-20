# pstack audit pack

Read [the audit](audit.md) or open [the pack page](index.html).
The inventory is in `audit.json`; `render.py` builds both views from that record.
No upstream code is executed and no plugin is installed.

Regenerate after changing the inventory or page text:

```sh
python3 docs/pstack-audit/render.py
python3 docs/pstack-audit/render.py --check
```

The check covers unique rows, allowed statuses, a Codex-unblocking answer for every pending item, every pinned and current pstack skill, every playbook and every changed upstream skill.
It also checks that both rendered views match the inventory.
The public GitHub revision links are frozen to the inspected commits.
Private lane files and personal incident details are not copied here.

The tailnet pack links to this directory through the existing packs server.
Keep the symlink pointing to the reviewed checkout until these commits are integrated, then repoint it to the integrated directory before removing this worktree.
The approved batch 1 model adapter and discovery changes have [local verification evidence](codex-discovery-proof.md).
The [ownership table](pending-ownership.md) tracks the original pending set across later batches.
Push, installation, rebuild, public sharing and live schedule changes remain separately gated.
