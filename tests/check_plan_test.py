#!/usr/bin/env python3
"""Tests for poteto-mode's scripts/check-plan.py against small plan files.

Pure: no network, writes only to a temp dir.
Run: python3 -I tests/check_plan_test.py
CHECK_PLAN=<path> runs the same cases against another copy of the checker.
"""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SKILL = REPO / "files/.claude/skills/poteto-mode"
CHECKER = Path(os.environ.get("CHECK_PLAN", SKILL / "scripts/check-plan.py"))
RULE = ("Tests alone are not sufficient verification. "
        "A PR is verified only when its unit and live boxes are checked.")

FILLED = f"""# Lean start plan

Trim the SessionStart hooks so a fresh thread starts smaller. PR 1 only.

## How to read this

One box is one unit of work, and each box names the evidence that checks it.

{RULE}

## Print counts from the hooks (PR 1)

**Depends on.** None.

**Files.**

- [ ] Edit `files/.claude/hooks/x.py`.

**Build.**

- [ ] Make `hook()` print counts from a `Map<string, number>`.

**You see.**

- [ ] The banner shows `sessions: 70`.

**Verify, unit.** {RULE}

- [ ] `tests/x_test.sh` gains a count case. Run `bash tests/x_test.sh`.

**Verify, live.** {RULE}

- [ ] Start a thread. Save `/tmp/a.txt`. Pass when the banner is one line.
- [ ] Regression against main: start a thread on main. Pass when the old banner prints.

**Review gate.** None. PR 1 changes no interaction.

## Close the program

- [ ] This plan file is deleted in the last PR.
"""


def skeleton():
    text = (SKILL / "references/plan.md").read_text(encoding="utf-8")
    return text.split("````markdown\n", 1)[1].split("````", 1)[0]


class CheckPlanTest(unittest.TestCase):
    def run_checker(self, plan):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp, "plan.md")
            path.write_text(plan, encoding="utf-8")
            r = subprocess.run([sys.executable, "-I", str(CHECKER), str(path)],
                               capture_output=True, text=True)
        return r.returncode, r.stdout + r.stderr

    def assert_fails(self, plan, needle):
        code, out = self.run_checker(plan)
        self.assertEqual(code, 1, out)
        self.assertIn(needle, out)

    def test_filled_plan_passes(self):
        code, out = self.run_checker(FILLED)
        self.assertEqual((code, out.strip()), (0, "ok"))

    def test_raw_skeleton_fails(self):
        self.assert_fails(skeleton(), "unfilled placeholder <Program>")

    def test_placeholder_left_in_backticks_fails(self):
        plan = FILLED.replace("Edit `files/.claude/hooks/x.py`", "Edit `<path>`")
        self.assert_fails(plan, "unfilled placeholder <path>")

    def test_placeholder_inside_a_command_fails(self):
        plan = FILLED.replace("Run `bash tests/x_test.sh`", "Run `bash <command>`")
        self.assert_fails(plan, "unfilled placeholder <command>")

    def test_never_deleted_fails(self):
        plan = FILLED.replace("- [ ] This plan file is deleted in the last PR.",
                              "- [ ] This plan file is never deleted.")
        self.assert_fails(plan, "needs the box")

    def test_delete_sentence_without_a_box_fails(self):
        plan = FILLED.replace("- [ ] This plan file is deleted in the last PR.",
                              "This plan file is deleted in the last PR.")
        self.assert_fails(plan, "needs the box")

    def test_placeholder_in_a_fenced_block_fails(self):
        plan = FILLED.replace("Run `bash tests/x_test.sh`.", "Run:\n\n  ```bash\n  bash <command>\n  ```")
        self.assert_fails(plan, "unfilled placeholder <command> in a code block")

    def test_rule_wrapped_onto_the_next_line_passes(self):
        plan = FILLED.replace(f"**Verify, unit.** {RULE}",
                              "**Verify, unit.** Tests alone are not sufficient verification.\n"
                              "A PR is verified only when its unit and live boxes are checked.")
        code, out = self.run_checker(plan)
        self.assertEqual((code, out.strip()), (0, "ok"))

    def test_verify_block_without_the_rule_fails(self):
        plan = FILLED.replace(f"**Verify, unit.** {RULE}", "**Verify, unit.**")
        self.assert_fails(plan, "'Verify, unit.' must open with the verification rule")

    def test_main_inside_another_word_is_not_a_regression_box(self):
        plan = FILLED.replace("- [ ] Regression against main: start a thread on main. Pass when the old banner prints.",
                              "- [ ] Check the remaining cases. Pass when they print.")
        self.assert_fails(plan, "needs a regression box against main")

    def test_missing_block_fails(self):
        plan = FILLED.replace("**Depends on.** None.\n\n", "")
        self.assert_fails(plan, "is missing **Depends on.**")

    def test_blocks_out_of_order_fails(self):
        files = "**Files.**\n\n- [ ] Edit `files/.claude/hooks/x.py`.\n\n"
        build = "**Build.**\n\n- [ ] Make `hook()` print counts from a `Map<string, number>`.\n\n"
        self.assertIn(files + build, FILLED)
        self.assert_fails(FILLED.replace(files + build, build + files), "blocks out of order")

    def test_live_box_without_pass_when_fails(self):
        plan = FILLED.replace("Pass when the banner is one line.", "The banner is one line.")
        self.assert_fails(plan, "each live box needs a 'Pass when' predicate")

    def test_em_dash_fails(self):
        plan = FILLED.replace("Trim the SessionStart hooks", "Trim the SessionStart hooks \u2014 all of them")
        self.assert_fails(plan, "em dash")


if __name__ == "__main__":
    unittest.main()
