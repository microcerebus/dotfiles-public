#!/usr/bin/env python3
"""Check a plan written from references/plan.md against its skeleton.

Usage: python3 -I check-plan.py <plan.md>
Prints one `path:line: problem` per finding and exits 1, or prints `ok` and exits 0.
"""
import re
import sys
from pathlib import Path

SKELETON = Path(__file__).resolve().parent.parent / "references/plan.md"
RULE = ("Tests alone are not sufficient verification. "
        "A PR is verified only when its unit and live boxes are checked.")
BLOCKS = ["Depends on.", "Files.", "Build.", "You see.",
          "Verify, unit.", "Verify, live.", "Review gate."]
NEEDS_BOX = {"Files.", "Build.", "You see.", "Verify, unit.", "Verify, live."}
BOX = re.compile(r"^\s*- \[[ x]\] (.*)$")
BLOCK = re.compile(r"^\*\*([^*]+)\*\*")
PLACEHOLDER = re.compile(r"<[A-Za-z][^<>]*>")
CODE_SPAN = re.compile(r"`[^`]*`")
DELETE_BOX = "This plan file is deleted in the last PR."


def skeleton_placeholders():
    """The placeholders in plan.md's skeleton, such as <path> and <command>."""
    text = SKELETON.read_text(encoding="utf-8")
    block = text.split("````markdown", 1)[1].split("````", 1)[0]
    return set(PLACEHOLDER.findall(block))


def main(path):
    with open(path, encoding="utf-8") as f:
        raw = f.read().splitlines()
    problems = []

    def fail(n, msg):
        problems.append(f"{path}:{n}: {msg}")

    lines, fenced, fence = [], [], None
    for n, text in enumerate(raw, 1):
        m = re.match(r"^\s*(`{3,}|~{3,})", text)
        if m and (fence is None or m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence)):
            fence = m.group(1) if fence is None else None
            continue
        (lines if fence is None else fenced).append((n, text))

    # Outside code, any <...> is a placeholder. Inside code, only the
    # skeleton's own ones are, so Map<K, V> or <div> can still be quoted.
    skeleton = skeleton_placeholders()
    for n, text in lines:
        bare = CODE_SPAN.sub("", text)
        if PLACEHOLDER.search(bare):
            fail(n, f"unfilled placeholder {PLACEHOLDER.search(bare).group(0)}")
        for span in CODE_SPAN.findall(text):
            for token in PLACEHOLDER.findall(span):
                if token in skeleton:
                    fail(n, f"unfilled placeholder {token} in {span}")
        if "—" in text:
            fail(n, "em dash; use a plain dash or a new sentence")
    for n, text in fenced:
        for token in PLACEHOLDER.findall(text):
            if token in skeleton:
                fail(n, f"unfilled placeholder {token} in a code block")

    if not any(t.startswith("# ") for _, t in lines):
        fail(1, "no '# <Program> plan' title")
    sections = []
    for n, text in lines:
        if text.startswith("## "):
            sections.append({"title": text[3:].strip(), "n": n, "body": []})
        elif sections:
            sections[-1]["body"].append((n, text))
    titles = [s["title"] for s in sections]
    for need in ("How to read this", "Close the program"):
        if need not in titles:
            fail(1, f"missing '## {need}' section")
    if problems and ("How to read this" not in titles or "Close the program" not in titles):
        return report(problems)

    def text_of(s):
        return " ".join(t.strip() for _, t in s["body"])

    how = sections[titles.index("How to read this")]
    if RULE not in text_of(how):
        fail(how["n"], "'How to read this' must state the verification rule verbatim")
    close = sections[titles.index("Close the program")]
    if not any((m := BOX.match(t)) and m.group(1).strip() == DELETE_BOX for _, t in close["body"]):
        fail(close["n"], f"'Close the program' needs the box '- [ ] {DELETE_BOX}'")

    prs = sections[titles.index("How to read this") + 1:titles.index("Close the program")]
    if not prs:
        fail(how["n"], "no PR sections between 'How to read this' and 'Close the program'")
    for s in prs:
        if not re.search(r"\([^()]+\)$", s["title"]):
            fail(s["n"], "PR heading must end with its id in parentheses")
        found, current = [], None
        boxes, opening = {}, {}
        for n, text in s["body"]:
            m = BLOCK.match(text)
            if m:
                current = m.group(1).strip()
                found.append(current)
                boxes[current] = []
                opening[current] = (n, [text.strip()])
            elif current and BOX.match(text):
                boxes[current].append((n, BOX.match(text).group(1)))
            elif current and not boxes[current]:
                opening[current][1].append(text.strip())
        # The rule may wrap onto the lines after the heading, before the first box.
        for b, (n, words) in opening.items():
            if b.startswith("Verify,") and RULE not in " ".join(w for w in words if w):
                fail(n, f"'{b}' must open with the verification rule")
        order = [b for b in found if b in BLOCKS]
        for b in BLOCKS:
            if b not in found:
                fail(s["n"], f"'{s['title']}' is missing **{b}**")
        if order != [b for b in BLOCKS if b in order]:
            fail(s["n"], f"blocks out of order: {', '.join(order)}")
        for b in NEEDS_BOX & set(found):
            if not boxes[b]:
                fail(s["n"], f"**{b}** needs at least one box")
        for n, box in boxes.get("Verify, live.", []):
            if "Pass when" not in box:
                fail(n, "each live box needs a 'Pass when' predicate")
        if not any(re.search(r"\bmain\b", box) for _, box in boxes.get("Verify, live.", [])):
            fail(s["n"], "**Verify, live.** needs a regression box against main")
    return report(problems)


def report(problems):
    if problems:
        print("\n".join(problems))
        return 1
    print("ok")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__.strip(), file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
