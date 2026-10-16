#!/usr/bin/env node
// Portable, syntactic PR-body policy. No URL fetches or environment-specific state.
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const titles = {
  context: 'Context / problem',
  solution: 'Solution',
  evidence: 'Before / after',
  test: 'Reproduce / test',
  followups: 'Follow-ups',
};
const aliases = new Map([
  ['context problem', 'context'], ['context', 'context'], ['problem', 'context'],
  ['context and problem', 'context'], ['solution', 'solution'],
  ['before after', 'evidence'], ['before and after', 'evidence'],
  ['reproduce test', 'test'], ['reproduce and test', 'test'],
  ['reproduction testing', 'test'], ['reproduction and testing', 'test'],
  ['reproduce', 'test'], ['test plan', 'test'], ['testing', 'test'],
  ['follow ups', 'followups'], ['follow up', 'followups'], ['followups', 'followups'],
]);
const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const placeholderWord = 'todo|tbd|placeholder|pending';
const placeholderPhrase = /\b(?:coming soon|to be (?:added|uploaded)|fill (?:this |in )?(?:in|here|steps)|insert (?:description|text|steps|image|screenshot)|your (?:description|text) here|describe (?:the |your )?(?:problem|solution|changes|steps))\b/i;
// A bare word is a placeholder only when it fills the line or opens a <...> or [...] marker.
const placeholderMarker = new RegExp(`^\\W*(?:${placeholderWord})\\W*$|[<\\[]\\s*(?:${placeholderWord})\\b[^<>\\[\\]]*[>\\]](?!\\()`, 'i');
const placeholder = { test: (line) => placeholderPhrase.test(line) || placeholderMarker.test(line) };

function withoutComments(body) {
  // Preserve source line numbers, including an unfinished comment at EOF.
  return body.replace(/<!--[\s\S]*?(?:-->|$)/g, (match) => match.replace(/[^\n]/g, ' '));
}

function visibleLines(body) {
  let fence;
  let detailsDepth = 0;
  return withoutComments(body).split(/\r?\n/).map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return '';
    }
    if (marker) { fence = marker[1]; return ''; }
    const wasCollapsed = detailsDepth > 0;
    let hasDetails = false;
    for (const tag of line.matchAll(/<\/?details\b[^>]*>/gi)) {
      hasDetails = true;
      detailsDepth = Math.max(0, detailsDepth + (/^<\//.test(tag[0]) ? -1 : 1));
    }
    // Details are collapsible even with an initial open attribute.
    if (wasCollapsed || hasDetails) return '';
    // Indented code and quoted examples are not rendered evidence or headings.
    return /^(?: {4}|\t| {0,3}>)/.test(line) ? '' : line;
  });
}

function meaningful(lines) {
  const prose = lines.filter((line) => !/^\s*#{1,6}\s/.test(line))
    .map((line) => line.replace(/<[^>]*>/g, '').replace(/^[\s*\-\d.)\[\]x]+/, '').trim())
    .filter(Boolean);
  return prose.some((line) => !placeholder.test(line) &&
    !/^(?:n\/?a|none|nothing|no(?: follow[ -]?ups?)?|not applicable)[.!]?$/i.test(line) && /[a-z]{2}/i.test(line));
}

function withoutInlineCode(line) {
  // Exact-length backtick delimiters, with a monotonic scan even for malformed spans.
  const runs = [...line.matchAll(/`+/g)];
  const next = new Map();
  const closing = new Map();
  for (let index = runs.length - 1; index >= 0; index--) {
    closing.set(index, next.get(runs[index][0].length));
    next.set(runs[index][0].length, index);
  }
  let output = '';
  let start = 0;
  for (let index = 0; index < runs.length; index++) {
    const end = closing.get(index);
    if (end === undefined) continue;
    output += line.slice(start, runs[index].index);
    start = runs[end].index + runs[end][0].length;
    index = end;
  }
  return output + line.slice(start);
}

function hasFlowProse(lines) {
  // Reject recognizable command inventories, not natural-language word choices.
  // Prose presence cannot establish whether a flow was executed or is correct.
  return meaningful(lines.filter((line) => {
    const item = line.replace(/^\s*(?:[-*+]\s+(?:\[[ x]\]\s*)?|\d+[.)]\s+)?/i, '').trim();
    if (/^(?:commands?|scripts?|checks?|validation|automated tests?)\s*:?$/i.test(item)) return false;
    if (/^(?:run\s+|execute\s+)?`[^`]+`(?:\s*(?:[,;]|and|then|or)\s*`[^`]+`)*[.!]?$/i.test(item)) return false;
    // Words that are also ordinary English count as commands only after a `$` prompt.
    // Tool names are lowercase command forms: a capitalized "Nix rebuild ..." is prose.
    if (/^(?:(?:[Rr]un|[Ee]xecute)\s+)?(?:\$\s*)?(?:pnpm|npm|npx|yarn|bun|nix|pytest|cargo)\s+[\w./:@=+\-\s"']+[.]?$/.test(item)) return false;
    if (/^(?:(?:[Rr]un|[Ee]xecute)\s+)?\$\s*(?:node|bash|sh|make|go test)\s+[\w./:@=+\-\s"']+[.]?$/.test(item)) return false;
    if (/^(?:\.\/|scripts\/)[\w./-]+(?:\s+[-\w./=]+)*[.]?$/.test(item)) return false;
    return true;
  }).map((line) => withoutInlineCode(line)
    .replace(/!?\[[^\]\n]*\]\([^\n)]*\)/g, '')
    .replace(/!?\[[^\]\n]*\]\s*\[[^\]\n]*\]/g, '')
    .replace(/^\s*\[[^\]\n]+\]:.*$/, '')
    .replace(/<a\b[^>]*>.*?<\/a\s*>/gi, '')
    .replace(/https?:\/\/[^\s<>]+/gi, '')));
}

function unavailableHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (/^(?:localhost|.*\.(?:localhost|local|invalid|test)|invalid|test)$/.test(host)) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(host) === 6) {
    if (host.startsWith('::ffff:')) {
      const mapped = host.slice(7);
      if (isIP(mapped) === 4) return unavailableHost(mapped);
      const words = mapped.split(':');
      if (words.length === 2) {
        const high = parseInt(words[0], 16);
        const low = parseInt(words[1], 16);
        return unavailableHost(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
      }
    }
    return /^(?:::|::1|f[cd][0-9a-f:]*|fe[89ab][0-9a-f:]*|ff[0-9a-f:]*)$/.test(host);
  }
  return false;
}

function httpsDestination(value) {
  if (/\b(?:todo|tbd|placeholder)\b/i.test(value) || /[<>\s\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      !unavailableHost(url.hostname);
  } catch { return false; }
}

function attachment(value) {
  try {
    const url = new URL(value);
    return url.hostname === 'github.com' &&
      /^\/(?:user-attachments\/assets\/[^/]+|[^/]+\/[^/]+\/assets\/[^/]+\/[^/]+)\/?$/.test(url.pathname);
  } catch { return false; }
}

function attributes(tag) {
  const attrs = new Map();
  for (const match of tag.matchAll(/\b([a-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const name = match[1].toLowerCase();
    if (attrs.has(name)) return new Map(); // Ambiguous duplicate attributes fail closed.
    attrs.set(name, match[2] ?? match[3]);
  }
  return attrs;
}

function tableCells(line) {
  return line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim());
}

function columnSide(cell) {
  const words = [...new Set([...cell.matchAll(/\b(before|after)\b/gi)].map((match) => match[1].toLowerCase()))];
  return words.length === 1 ? words[0] : undefined;
}

function visualEvidence(section, add) {
  const urls = { before: new Set(), after: new Set() };
  let label;
  let labelLine = -1;
  let video;
  let header; // Per-column sides of the Markdown table the current line belongs to.
  for (let index = 0; index < section.lines.length; index++) {
    const line = withoutInlineCode(section.lines[index]);
    const sourceLine = section.line + index + 1;
    const mediaNoun = '(?:media|evidence|screenshots?|recordings?|videos?|images?)';
    const unavailable = '(?:missing|pending|unavailable|not (?:yet )?(?:available|captured|uploaded))';
    if (placeholderMarker.test(line) || /\b(?:coming soon|to be uploaded|pending upload)\b/i.test(line) ||
        new RegExp(`\\b${mediaNoun}\\s+(?:(?:are|is)\\s+)?${unavailable}\\b|\\b${unavailable}\\s+${mediaNoun}\\b`, 'i').test(line)) {
      add('evidence-not-ready', 'Replace pending or missing evidence with the actual before and after media.', sourceLine);
      continue;
    }
    // Hidden/container HTML is deliberately unsupported rather than treated as visible.
    if (/<\/?(?:div|span|template|script|style|pre|code)\b|\b(?:hidden|aria-hidden)\b|style\s*=/i.test(line)) {
      add('unsupported-media', 'Use plainly visible Markdown images or labeled GitHub recordings; hidden or styled HTML evidence is unsupported.', sourceLine);
      continue;
    }
    const isRow = line.trim().startsWith('|');
    if (!isRow) header = undefined;
    else if (/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) {
      const previous = index > 0 ? section.lines[index - 1] : '';
      header = previous.trim().startsWith('|') ? tableCells(previous).map(columnSide) : undefined;
      continue;
    }
    const labelMatch = line.match(/^\s*(?:#{1,6}\s+|\*\*|__)?(before|after)(?:\b)(.*)$/i);
    if (labelMatch && !/\b(?:before|after)\b/i.test(labelMatch[2])) {
      label = labelMatch[1].toLowerCase();
      labelLine = index;
    }
    const scan = (text, column) => {
      const accept = (url, caption) => {
        if (!httpsDestination(url)) {
          add('media-url', 'Use an actual HTTPS media destination, without placeholders or local paths.', sourceLine);
          return;
        }
        const ownLabels = [...caption.matchAll(/\b(before|after)\b/gi)].map((match) => match[1].toLowerCase());
        const unique = [...new Set(ownLabels)];
        const leadingLabel = caption.match(/^\s*(before|after)\s*:/i)?.[1].toLowerCase();
        // A table header column names the side; only an explicit contradicting caption label cancels it.
        const side = column
          ? (leadingLabel && leadingLabel !== column ? undefined : column)
          : leadingLabel ?? (unique.length === 1 ? unique[0] : unique.length === 0 && labelLine >= 0 ? label : undefined);
        if (side) urls[side].add(new URL(url).href);
      };
      // Inline images only. Reference-style images and complex destinations fail closed.
      for (const match of text.matchAll(/(?<!\\)!\[([^\]\n]+)\]\(\s*(?:<([^<>\s]+)>|([^\s()]+))(?:\s+["'][^"'\n]*["'])?\s*\)/g)) {
        accept(match[2] ?? match[3], match[1]);
      }
      for (const match of text.matchAll(/(?<![!\\])\[([^\]\n]+)\]\((https:\/\/[^\s()]+)\)/g)) {
        if (attachment(match[2])) accept(match[2], match[1]);
      }
      // GitHub renders bare attachment recordings as media.
      const bare = text.trim().match(/^(?:<)?(https:\/\/[^<>\s]+)>?$/);
      if (bare && attachment(bare[1])) accept(bare[1], '');
      for (const match of text.matchAll(/<img\b[^>]*>/gi)) {
        const attrs = attributes(match[0]);
        if (attrs.has('src') && attrs.get('alt')?.trim()) accept(attrs.get('src'), attrs.get('alt'));
      }
      // Require controls and a label for HTML video; support a quoted src or source.
      for (const match of text.matchAll(/<video\b[^>]*>|<source\b[^>]*>|<\/video\s*>/gi)) {
        if (/^<video\b/i.test(match[0])) {
          const attrs = attributes(match[0]);
          video = /\bcontrols(?:\s|=|>)/i.test(match[0]) ? { text: attrs.get('aria-label') ?? '', src: attrs.get('src') } : undefined;
        } else if (/^<source\b/i.test(match[0]) && video && !video.src) {
          video.src = attributes(match[0]).get('src');
        } else if (/^<\/video/i.test(match[0])) {
          if (video?.src) accept(video.src, video.text);
          video = undefined;
        }
      }
    };
    if (isRow && header) tableCells(line).forEach((cell, column) => scan(cell, header[column]));
    else scan(line);
  }
  for (const side of ['before', 'after']) {
    if (!urls[side].size) add('missing-media', `Add labeled ${side} media in Before / after: an embedded HTTPS image or GitHub attachment recording.`, section.line);
  }
  if ([...urls.before].some((url) => urls.after.has(url))) {
    add('duplicate-media', 'Use different media for before and after; the same URL cannot show both.', section.line);
  }
}

function ciInventory(body, add) {
  const patterns = [
    /\b\d+\s+(?:(?:unit|integration|e2e|end.to.end|jsdom|chrome|browser)\s+)*(?:tests?|cases?|checks?|specs?|suites?)\s+(?:pass(?:ed|es)?|succeed(?:ed)?|green)\b/i,
    /\b\d+\s+(?:tests?|cases?|checks?|specs?|suites?)\s+(?:failed|skipped)\b/i,
    /\b\d+\s+(?:passed|failed|skipped)\s*,\s*\d+\s+(?:passed|failed|skipped)\b/i,
    /\b\d+\s+passed(?=\s*(?:[.;)]|$))/i,
    /\ball\s+(?:\w+\s+)?tests?\s+(?:now\s+)?(?:pass(?:ed|es|ing)?|are\s+green)\b/i,
    /^\s*(?:[-*+]\s*)?(?:tests?|lint|typecheck|type checks?|format|build)\s+(?:pass(?:es|ed)?|(?:is|are)\s+(?:green|clean))\s*[.!]?\s*$/i,
    /^\s*\|\s*(?:lint|typecheck|type check|unit tests?|tests?|e2e|format|build)\s*\|\s*(?:✅|✔|✓|pass(?:ed)?|green|OK)\s*\|?\s*$/iu,
    /`[^`]+`(?:\s*(?:,|;|and)\s*`[^`]+`)*\s+(?:all\s+)?pass(?:ed|es)?\s*[.!]?\s*$/i,
    /\b(?:all\s+)?(?:CI\s+)?checks\s+(?:(?:have|are|were)\s+)?pass(?:ed|ing)?\b/i,
    /\b(?:CI|pipeline|build)\s*[:=-]?\s*(?:passed|green|successful)\b/i,
    /(?:`[^`]+`|\b(?:pnpm|npm|yarn|bun|nix|node)\s+[^:]+)\s*[:=-]\s*(?:pass(?:ed)?|success(?:ful)?|OK|green|clean|no errors|0 errors|exit(?:ed)?\s+0)\b/i,
    /^\s*(?:[-*|]\s*)?(?:lint|typecheck|unit tests?|e2e|build)\s*[:|=-]\s*(?:passed|green|clean|OK|0 errors)\b/i,
    /^\s*(?:[|*+-]\s*)?(?:PASS|FAIL)\s+(?:\S+\.(?:test|spec)\.|\S+\/)/,
    /\b(?:Tests?|Test Files|Test Suites)\s*:\s*\d+\s+(?:passed|failed|total)\b/i,
    /^\s*[-*|]?\s*(?:✅|✔|✓)\s*`[^`]+`/u,
  ];
  withoutComments(body).split(/\r?\n/).forEach((line, index) => {
    if (patterns.some((pattern) => pattern.test(line))) {
      add('ci-inventory', 'Remove routine CI results or command-result inventories; describe coverage in Solution and manual steps with expected behavior in Reproduce / test.', index + 1);
    }
  });
}

/** Returns policy findings; throws TypeError for an invalid API contract. */
export function validatePrDescription(body, options) {
  if (typeof body !== 'string' || typeof options?.visualScope !== 'boolean') {
    throw new TypeError('Expected body:string and an explicit visualScope:boolean.');
  }
  const findings = [];
  const add = (code, message, line) => findings.push({ code, message, ...(line ? { line } : {}) });
  const lines = visibleLines(body);
  const headings = [];
  lines.forEach((line, index) => {
    const match = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match) headings.push({ level: match[1].length, title: match[2], key: aliases.get(normalize(match[2])), line: index + 1 });
  });
  const known = headings.filter((heading) => heading.key);
  const level = known.length ? Math.min(...known.map((heading) => heading.level)) : 2;
  const sections = headings.filter((heading) => heading.level <= level).map((heading, index, all) => ({
    ...heading, lines: lines.slice(heading.line, all[index + 1] ? all[index + 1].line - 1 : lines.length),
  }));
  const byKey = new Map();
  for (const section of sections) {
    if (!section.key) {
      add('section-shape', `Use the canonical sections; move "${section.title}" under the relevant section.`, section.line);
      continue;
    }
    if (byKey.has(section.key)) add('duplicate-section', `Keep one ${titles[section.key]} section.`, section.line);
    else byKey.set(section.key, section);
    if (section.key !== 'evidence' && !meaningful(section.lines)) {
      add('empty-section', `Provide meaningful ${titles[section.key]} content; omit Follow-ups when there are no real items.`, section.line);
    }
  }
  for (const key of ['context', 'solution', 'test']) {
    if (!byKey.has(key)) add('missing-section', `Add a meaningful ${titles[key]} section.`);
  }
  let previous = 0;
  for (const key of ['context', 'solution', 'test', 'evidence', 'followups']) {
    const section = byKey.get(key);
    if (!section) continue;
    if (section.line < previous) add('section-order', 'Order sections as Context / problem, Solution, Reproduce / test, optional Before / after, then optional Follow-ups.', section.line);
    previous = section.line;
  }
  const evidence = byKey.get('evidence');
  const testSection = byKey.get('test');
  if (testSection && !hasFlowProse(testSection.lines)) {
    add('test-flow', 'Describe user actions and observable outcomes, or summarize the flow and link deeper issue/ticket scenarios; a script list alone is insufficient.', testSection.line);
  }
  if (options.visualScope && !evidence) add('missing-evidence', 'Add Before / after with labeled before and after media for this visual change.');
  if (evidence) {
    visualEvidence(evidence, add);
  }
  ciInventory(body, add);
  return findings;
}

function main(args) {
  try {
    let body;
    let visualScope;
    if (args.length === 1 && args[0] === '--body-json-stdin') {
      const value = JSON.parse(readFileSync(0, 'utf8'));
      body = value?.body;
      visualScope = value?.visualScope;
    } else {
      const flags = new Map();
      for (let index = 0; index < args.length; index += 2) {
        const flag = args[index];
        if (!['--body-file', '--visual-scope'].includes(flag) || flags.has(flag) || args[index + 1] === undefined) throw new Error('Invalid or duplicate arguments.');
        flags.set(flag, args[index + 1]);
      }
      if (flags.size !== 2 || !['true', 'false'].includes(flags.get('--visual-scope'))) throw new Error('An explicit --visual-scope true|false is required.');
      body = readFileSync(flags.get('--body-file'), 'utf8');
      visualScope = flags.get('--visual-scope') === 'true';
    }
    const findings = validatePrDescription(body, { visualScope });
    for (const finding of findings) process.stderr.write(`${finding.code}${finding.line ? ` (line ${finding.line})` : ''}: ${finding.message}\n`);
    if (findings.length) process.exitCode = 1;
    else process.stdout.write('PR description passes syntactic policy checks.\n');
  } catch (error) {
    process.stderr.write(`Invalid usage: ${error.message}\nUsage: node check-pr-description.mjs --body-file FILE --visual-scope true|false\n   or: node check-pr-description.mjs --body-json-stdin\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
