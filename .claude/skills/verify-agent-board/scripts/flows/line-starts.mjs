// The board's line rules, checked where lines exist: in the browser, after layout. Markup can put a no-break space
// before every "·" and Chrome may still start a line with one (it breaks after an inline-block even before a no-break
// space), so this reads the rendered lines rather than the HTML.
//
// drawnLines runs inside the page (page.evaluate). It walks every visible character of the body in document order
// and starts a new line whenever a character's vertical middle leaves the previous character's box: a wrap, a new
// block, or the jump to the next column. It returns every line with its text and position, the text starting at the
// line's first visible character, and whether it wraps on from the line before inside the same block (an inline-block
// counts as a block).
export function drawnLines() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  const lines = [];
  const blockOf = (el) => {
    while (el.parentElement && ['inline', 'contents'].includes(getComputedStyle(el).display)) el = el.parentElement;
    return el;
  };
  let prev = null;
  let prevBlock = null;
  let line = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.data;
    const block = node.parentElement ? blockOf(node.parentElement) : null;
    for (let i = 0; i < text.length;) {
      const ch = String.fromCodePoint(text.codePointAt(i));
      const at = i;
      i += ch.length;
      // \s covers the no-break space, so a line that begins "&nbsp;·" counts as beginning with "·".
      if (/\s/.test(ch)) {
        if (line) line.text += ' ';
        continue;
      }
      range.setStart(node, at);
      range.setEnd(node, i);
      const r = range.getClientRects()[0];
      if (!r || (!r.width && !r.height)) continue;
      const mid = r.top + r.height / 2;
      if (!prev || mid < prev.top || mid > prev.bottom) {
        line = { text: '', x: Math.round(r.left), y: Math.round(r.top + scrollY), wrapped: Boolean(prev) && block === prevBlock };
        lines.push(line);
      }
      line.text += ch;
      prev = r;
      prevBlock = block;
    }
  }
  return lines;
}

// keptInOrder runs inside the page too. It finds the open check whose name ends in a kept phrase (prose()'s span) and
// says whether that phrase is drawn after the words before it: below their last character, or on its line and to its
// right. A flex box makes each child element its own column, which puts the phrase beside the first line instead.
export function keptInOrder(name) {
  const kept = [...document.querySelectorAll('details[open] .check .kept')].find((k) => name.endsWith(k.textContent));
  const before = kept?.previousSibling;
  if (before?.nodeType !== Node.TEXT_NODE) return { found: false };
  const range = document.createRange();
  const end = before.data.trimEnd().length;
  range.setStart(before, end - 1);
  range.setEnd(before, end);
  const last = range.getBoundingClientRect();
  const first = kept.getClientRects()[0];
  return { found: true, before: before.data.trim(), kept: kept.textContent,
    inOrder: first.top >= last.bottom - 1 || (Math.abs(first.top - last.top) < 2 && first.left >= last.right - 1) };
}

const shown = ({ text, x, y }) => ({ text: text.trim().slice(0, 80), x, y });

// The three rules over drawn lines: no line starts with "·", a parenthetical of up to 24 characters (the board's
// prose()) sits on one line, and a count stays on the line of the word it counts (counted()): no line ends in a bare
// number that the next line of the same block carries on from with a word. Empty lists mean the page keeps all three.
export function lineFaults(lines) {
  const dotStarts = lines.filter((l) => l.text.startsWith('·')).map(shown);
  const splitParens = [];
  const bareCounts = [];
  lines.forEach((l, i) => {
    const next = lines[i + 1];
    const open = l.text.trimEnd().match(/\(([^()]*)$/);
    const close = next?.text.match(/^([^()]*)\)/);
    if (open && close && `${open[1].trim()} ${close[1]}`.length <= 22) splitParens.push({ ...shown(l), text: `${open[0].trim()} / ${close[0]}` });
    const count = l.text.trimEnd().match(/(?:^|\s)(\d+)$/);
    const word = next?.wrapped && next.text.match(/^[a-z]+/i);
    if (count && word) bareCounts.push({ ...shown(l), text: `${count[1]} / ${word[0]}` });
  });
  return { dotStarts, splitParens, bareCounts };
}

// Every faulty line, for a report: "·" starts, then split parentheticals, then bare counts.
export const faultLines = (f) => [...f.dotStarts, ...f.splitParens, ...f.bareCounts];
