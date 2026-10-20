#!/usr/bin/env python3
"""Render and check this audit pack from its evidence inventory, using stdlib only."""
import collections
import html
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent
DATA = json.loads((ROOT / 'audit.json').read_text())
ROWS = DATA['rows']
STATUSES = ('adopted', 'adapted', 'skipped', 'pending')
CONFLICTS = [
    ('Taste cutoff', 'The old GPT taste score excludes user-facing Codex work.', 'Replace the provider score with artifact acceptance checks and use Claude for demonstrated gaps.'),
    ('Fable design default', 'Design and design reviews still name Fable.', 'Use Astra High with the same design checks; keep Fable as a capability fallback.'),
    ('Opus writing default', 'The all-writing mandate conflicts with Codex-first conversations.', 'Use Codex plus unslop, with Opus only when the writing misses the bar.'),
    ('Reader trial', 'Haiku/Sonnet collection through 22 October conflicts with Sol Low.', 'Stop new trial assignments and retain the results for the planned review.'),
    ('Hardcoded skill roles', 'Poteto-mode, how, why, reflect and scratch evaluation still name Claude tools or models.', 'Batch 1 maps collection to Sol Low and judgment to Astra High; local registration and invocation proof precede rollout.'),
    ('Cross-family reviews', 'Arena and show-me-your-work require another family or a Fable judge.', 'Use fresh-context Codex review by default; Claude needs an explicit task exception or a demonstrated capability/quota fallback.'),
    ('Personal model preferences', 'OPINIONS still prefers Claude and describes Codex only as a fallback.', 'The exact five-sentence replacement was finalized and applied locally; VOICE and the adjacent list are unchanged.'),
    ('Fallback watcher restoration', 'The dry-run watcher would restore Claude after its reset.', 'Keep it disabled; redesign restoration and queued-message recovery before activation.'),
]
SOURCES = [
    ('Pinned pstack 0.15.24', f'https://github.com/cursor/plugins/tree/{DATA["pin"]}/pstack'),
    ('Inspected pstack 0.15.29', f'https://github.com/cursor/plugins/tree/{DATA["head"]}/pstack'),
    ('Exact upstream comparison', f'https://github.com/cursor/plugins/compare/{DATA["pin"]}...{DATA["head"]}'),
    ('New Claude Code adapter', f'https://github.com/cursor/plugins/blob/{DATA["head"]}/pstack/docs/harness/claude-code.md'),
    ('Code-review article', 'https://claude.dev/blog/solving-code-review-at-anthropic/'),
    ('Better Stack video', 'https://www.youtube.com/watch?v=d8QpDbBKbAU'),
]
INTRO = [
    'The core pstack workflow is present, but not every item is adopted or operational.',
    'The old Later list is stale: the explanation and multi-model skills, reflect and poteto-mode are installed; the TypeScript project skill is merged.',
    'Batch 1 prepares Codex roles and 27 skill aliases locally; fresh scratch sessions prove discovery and router invocation. Live rollout remains pending.',
    'Upstream is now 0.15.29, compared with the dotfiles pin at 0.15.24; the two new formal-verification skills and Claude Code package have not been adopted.',
]
DECISION = [
    'The eight routing decisions and exact OPINIONS paragraph are approved. Batch 1 is prepared locally, with no push or activation authorization.',
    'The orchestrator owns later batch assignment; upstream changes still need comparison with local patches before implementation.',
    'The job-tracker coordinator owns order 71: the two-strike rule is in force, the async guard is active work, the size cap follows it, and the four larger rows start after 22 October at 16:00 SGT.',
    'No live skill registration, dependency, plugin, schedule or provider setting was installed or enabled by this audit or batch 1.',
]
LIMITS = [
    'Checked on 20 October 2026 at 19:01 SGT using local files and read-only GitHub calls; the head is frozen in audit.json.',
    'Batch 1 updates record local preparation and orchestrator corrections; codex-discovery-proof.md separates scratch verification from live rollout.',
    'Adopted means an inspected installation, declaration or explicitly retained practice; adapted means an inspected local equivalent.',
    'Neither status claims that every workflow has run successfully on Codex; pending means a named blocker, missing proof or unselected update remains.',
    'Pending update rows are separate from the adoption status of the pinned item, so an adapted skill can also have an unselected upstream change.',
    'The 61 upstream commits cover the entire cursor/plugins repository, not only pstack; the inventory covers all 54 pinned skills, all 56 current skills and all 23 playbooks, plus support tools and the named source audits.',
    'Historical source reports are treated as evidence of their recommendations, not proof of current deployment; remote main corrected the stale TypeScript status.',
    'The code-review article and video were assessed through the supplied source report; they were not independently retranscribed in this audit.',
    'Evidence paths name repository files or source-report sections; bare skill paths are relative to files/.claude/skills, and private source text is not copied into this pack.',
]

def check_inventory():
    keys = [(r['group'], r['item']) for r in ROWS]
    assert len(keys) == len(set(keys)), 'Duplicate audit item'
    for row in ROWS:
        assert row['status'] in STATUSES and all(row.values()), row
        assert chr(0x2014) not in ' '.join(row.values()), row['item']
        if row['status'] == 'pending':
            assert row['codex'] != 'Not pending.', row['item']
    skills = {r['item'] for r in ROWS if r['group'] in ('pstack skill', 'pstack principle')}
    assert set(DATA['skills_at_pin']) | set(DATA['skills_at_head']) == skills, 'Incomplete skill inventory'
    assert {r['item'] for r in ROWS if r['group'] == 'pstack playbook'} == set(DATA['playbooks']), 'Incomplete playbook inventory'
    changes = {p.split('/')[2] for p in DATA['changed_pstack_files'] if p.startswith('pstack/skills/')}
    covered = {r['item'] for r in ROWS if r['group'] == 'Upstream delta'} | {r['item'] for r in ROWS if r['group'] == 'pstack skill' and r['status'] == 'pending'}
    assert changes <= covered, f'Uncovered upstream changes: {changes - covered}'


def markdown():
    text = '# pstack adoption audit\n\n'
    text += '\n'.join(INTRO) + '\n\n## Rollout status\n\n'
    text += '\n'.join('- ' + x for x in DECISION) + '\n\n## What the statuses mean\n\n'
    text += '\n'.join(LIMITS) + '\n\n## Adoption record\n\n'
    text += '| Source group | Item | Status | Evidence | Current state or blocker | Does Codex unblock it? |\n|---|---|---|---|---|---|\n'
    for r in ROWS:
        text += '| ' + ' | '.join(r[k].replace('|', '\\|') for k in ('group', 'item', 'status', 'evidence', 'reason', 'codex')) + ' |\n'
    text += '\n## Approved routing resolutions\n\n'
    for title, conflict, recommendation in CONFLICTS:
        text += f'- {title}: {conflict}\n  Approved resolution: {recommendation}\n'
    text += '\n## Sources\n\n'
    for title, url in SOURCES:
        text += f'- [{title}]({url})\n'
    text += '- Local install list: docs/claude-process/private/review.html, sections 5 and 6.\n'
    text += '- Original survey: docs/claude-process/private/notes/pstack-catalog.md and poteto-other-articles.md.\n'
    text += '- Local implementation: nix/user.nix, files/.claude/skills, docs/workflow-north-star.md and docs/agent-team.md.\n'
    text += '- Code-review recommendations: the supplied 19 October source report and current job-tracker standing order 71.\n'
    text += '- Read-only GitHub checks: job-tracker remote main skill tree, TypeScript skill merge, promise lint overrides and prerequisite PR states.\n'
    return text


def page():
    esc = html.escape
    count = collections.Counter(r['status'] for r in ROWS)
    groups = list(dict.fromkeys(r['group'] for r in ROWS))
    options = ''.join(f'<option value="{esc(g)}">{esc(g)}</option>' for g in groups)
    body = ''
    for i, row in enumerate(ROWS):
        body += f'<tr data-status="{row["status"]}" data-group="{esc(row["group"])}" id="item-{i+1}">'
        for key, label in [('item','Item'),('status','Status'),('reason','Current state or blocker'),('codex','Does Codex unblock it?'),('evidence','Evidence')]:
            value = esc(row[key])
            if key == 'item': value = f'<strong>{value}</strong><small>{esc(row["group"])}</small>'
            if key == 'status': value = f'<span class="status {row[key]}">{value}</span>'
            body += f'<td data-label="{label}">{value}</td>'
        body += '</tr>\n'
    conflicts = ''.join(f'<li><strong>{esc(t)}.</strong> {esc(c)} <span>{esc(r)}</span></li>' for t,c,r in CONFLICTS)
    sources = ''.join(f'<li><a href="{esc(u)}">{esc(t)}</a></li>' for t,u in SOURCES)
    stats = ''.join(f'<span><b>{count[s]}</b> {s}</span>' for s in STATUSES)
    return '''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>pstack adoption audit</title>
<style>
:root{color-scheme:dark;--bg:#1e1e2e;--panel:#181825;--text:#cdd6f4;--dim:#a6adc8;--line:#45475a;--blue:#89b4fa;--green:#a6e3a1;--yellow:#f9e2af}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 'JetBrains Mono Nerd Font','JetBrains Mono',monospace}main{max-width:1440px;margin:auto;padding:28px}h1{font-size:30px;line-height:1.2;margin:8px 0 16px}h2{font-size:19px;margin:20px 0 10px}p{margin:8px 0}a{color:var(--blue)}.kicker,small,.muted{color:var(--dim)}.kicker{font-size:12px;letter-spacing:.08em}small{display:block;font-size:12px;margin-top:4px}.summary{max-width:1000px}.decision{padding:18px 22px;background:var(--panel);border:1px solid var(--line);border-radius:12px;margin:22px 0}.decision h2{margin-top:0}li{margin:9px 0}ul,ol{padding-left:24px}.stats{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}.stats span{border:1px solid var(--line);padding:8px 12px;border-radius:8px}.filters{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr) minmax(0,1fr);gap:12px;margin:12px 0}.filters>*{min-width:0}label{font-size:13px;color:var(--dim)}input,select,button{font:inherit;color:var(--text);background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:10px;width:100%;margin-top:4px}button{width:auto;cursor:pointer}input:focus,select:focus,button:focus,a:focus{outline:2px solid var(--blue);outline-offset:3px}.scroll{max-height:880px;overflow:auto;border:1px solid var(--line);border-radius:10px;margin:14px 0}table{border-collapse:collapse;width:100%;min-width:1020px;font-size:13px}caption{text-align:left;padding:14px;background:var(--panel)}th,td{text-align:left;vertical-align:top;padding:14px;border-bottom:1px solid var(--line);overflow-wrap:break-word}th{position:sticky;top:0;background:var(--panel);z-index:1}td:nth-child(1){width:17%}td:nth-child(2){width:9%}td:nth-child(3){width:31%}td:nth-child(4){width:22%}td:nth-child(5){width:21%;font-size:12px;color:var(--dim)}tr[hidden]{display:none!important}.status{display:inline-block;border-radius:5px;padding:2px 5px;background:#313244}.adopted{color:var(--green)}.adapted{color:var(--blue)}.pending{color:var(--yellow)}details{margin:18px 0;border:1px solid var(--line);border-radius:10px;padding:14px 18px}summary{cursor:pointer;font-weight:600}details li span{display:block;color:var(--dim)}#empty{display:none;padding:18px}footer{margin-top:22px;font-size:12px;color:var(--dim)}
@media(max-width:1100px){main{padding:18px 14px}h1{font-size:25px}.filters{grid-template-columns:minmax(0,1fr)}.decision{padding:14px}table{min-width:0}thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}tbody,tr,td{display:block;width:100%!important}tr{padding:14px;border-bottom:2px solid var(--line)}td{padding:5px 0;border:0}td:before{content:attr(data-label);display:block;font-size:11px;color:var(--dim);margin-bottom:3px}td:first-child:before{display:none}td:first-child{font-size:16px}td:nth-child(2):before{display:none}.scroll{max-height:920px}.stats{gap:7px}.stats span{font-size:12px;padding:6px 8px}}
</style></head><body><main>
<div class="kicker">WORKFLOW AUDIT · 20 OCTOBER 2026</div><h1>What we adopted from pstack</h1>
<div class="summary">''' + f'<p>{esc(INTRO[0])}</p>' + '''</div>
<section class="decision"><h2>Rollout status</h2><ol>''' + ''.join(f'<li>{esc(x)}</li>' for x in DECISION[:2]) + '''</ol><p class="muted">''' + esc(DECISION[3]) + '''</p></section><div class="summary">''' + ''.join(f'<p>{esc(x)}</p>' for x in INTRO[1:] + [DECISION[2]]) + '''</div>
<div class="stats">''' + stats + '''</div>
<h2>One adoption record</h2><p class="muted">All items are shown initially. Filter by status, source group or text; update rows describe changes beyond an already adopted pin.</p>
<div class="filters"><label>Find an item<input id="search" type="search" placeholder="For example: reflect, timer, Codex"></label><label>Status<select id="status"><option value="">All statuses</option>''' + ''.join(f'<option>{s}</option>' for s in STATUSES) + '''</select></label><label>Source group<select id="group"><option value="">All sources</option>''' + options + '''</select></label></div>
<p id="shown" role="status" aria-live="polite">Showing all ''' + str(len(ROWS)) + ''' items.</p><button id="reset" type="button">Clear filters</button>
<div class="scroll" tabindex="0" aria-label="Scrollable adoption record"><table><caption>Evidence, current adoption and remaining blockers for each item.</caption><thead><tr><th scope="col">Item</th><th scope="col">Status</th><th scope="col">Current state or blocker</th><th scope="col">Does Codex unblock it?</th><th scope="col">Evidence</th></tr></thead><tbody>''' + body + '''</tbody></table><p id="empty">No items match. Clear the filters to see the full record.</p></div>
<details><summary>Eight approved routing resolutions</summary><ol>''' + conflicts + '''</ol></details>
<details><summary>Scope and limits of the evidence</summary>''' + ''.join(f'<p>{esc(x)}</p>' for x in LIMITS) + '''</details>
<details><summary>Source links and downloadable record</summary><ul>''' + sources + '''<li><a href="codex-discovery-proof.md">Batch 1 discovery proof</a></li><li><a href="pending-ownership.md">Original 42 pending entries and owners</a></li><li><a href="audit.md">Complete Markdown table</a></li><li><a href="audit.json">Evidence inventory and pinned upstream revisions</a></li></ul><p>Local evidence: the original install list and catalog, workflow-north-star.md, nix/user.nix, installed skill files, the supplied code-review report, current standing order 71 and read-only forge checks.</p></details>
<footer>Catppuccin Mocha with JetBrains Mono. Tailnet pack; no external assets or analytics.</footer>
</main><script>
const rows=[...document.querySelectorAll('tbody tr')];
const search=document.getElementById('search'), status=document.getElementById('status'), group=document.getElementById('group');
function filter(){const q=search.value.trim().toLowerCase();let n=0;for(const r of rows){const show=(!status.value||r.dataset.status===status.value)&&(!group.value||r.dataset.group===group.value)&&(!q||r.textContent.toLowerCase().includes(q));r.hidden=!show;if(show)n++;}document.getElementById('shown').textContent=`Showing ${n} of ${rows.length} items.`;document.getElementById('empty').style.display=n?'none':'block';}
for(const e of [search,status,group])e.addEventListener('input',filter);
document.getElementById('reset').addEventListener('click',()=>{search.value='';status.value='';group.value='';filter();});
console.log('Audit rows:',rows.length,'document width:',document.documentElement.scrollWidth,'viewport:',innerWidth);
</script></body></html>
'''

check_inventory()
outputs = {'audit.md': markdown(), 'index.html': page()}
if '--check' in sys.argv:
    for name, content in outputs.items():
        assert (ROOT / name).read_text() == content, f'{name} is stale; run render.py'
    print(f'Audit check passed: {len(ROWS)} unique rows, {len(DATA["skills_at_head"])} current skills, {len(DATA["playbooks"])} playbooks, all upstream skill changes covered; rendered files match.')
else:
    for name, content in outputs.items():
        (ROOT / name).write_text(content)
    print(f'Rendered {len(ROWS)} audit rows.')
