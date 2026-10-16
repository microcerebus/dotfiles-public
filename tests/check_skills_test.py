#!/usr/bin/env python3
"""Tests for scripts/check-skills against a tiny skills tree.

Pure: no network, writes only to a temp dir.
Run: python3 -I tests/check_skills_test.py (needs PyYAML, like the checker).
CHECK_SKILLS=<path> runs the same cases against another copy of the checker.
"""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CHECKER = Path(os.environ.get("CHECK_SKILLS", REPO / "scripts/check-skills"))
GOOD = """---
name: {name}
description: "Does one thing. Use it when that thing comes up."
---

# {name}

Read `references/notes.md`, then `other/SKILL.md`.
"""


class CheckSkillsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.skills = self.root / "skills"
        self.nix = self.root / "user.nix"
        self.local = self.root / "repo-skills"
        self.add_skill("good", GOOD.format(name="good"))
        (self.skills / "good/references").mkdir()
        (self.skills / "good/references/notes.md").write_text("notes\n")
        self.add_skill("other", GOOD.format(name="other").replace(", then `other/SKILL.md`", ""))
        (self.skills / "other/references").mkdir()
        (self.skills / "other/references/notes.md").write_text("notes\n")

    def tearDown(self):
        self.tmp.cleanup()

    def add_skill(self, name, skill_md, link=True):
        d = self.skills / name
        d.mkdir(parents=True)
        (d / "SKILL.md").write_text(skill_md, encoding="utf-8")
        (d / "LICENSE").write_text("MIT\n")
        if link:
            self.link(name)

    def link(self, name):
        with self.nix.open("a") as f:
            f.write(f'  home.file.".claude/skills/{name}".source = link "files/.claude/skills/{name}";\n')

    def run_checker(self, local=False):
        extra = ["--local", str(self.local)] if local else []
        r = subprocess.run([sys.executable, "-I", str(CHECKER), str(self.skills), "--nix", str(self.nix), *extra],
                           capture_output=True, text=True)
        return r.returncode, r.stdout + r.stderr

    def add_local(self, name, skill_md):
        d = self.local / name
        d.mkdir(parents=True)
        (d / "SKILL.md").write_text(skill_md, encoding="utf-8")
        (d / "LICENSE").write_text("MIT\n")

    def assert_fails(self, needle, local=False):
        code, out = self.run_checker(local)
        self.assertEqual(code, 1, out)
        self.assertIn(needle, out)

    def test_good_tree_passes(self):
        code, out = self.run_checker()
        self.assertEqual(code, 0, out)
        self.assertIn("all skills ok", out)

    def test_mention_of_a_missing_skill_fails(self):
        (self.skills / "good/SKILL.md").write_text(GOOD.format(name="good").replace("other/SKILL.md", "hw/SKILL.md"))
        self.assert_fails("hw/SKILL.md does not resolve")

    def test_references_path_in_another_repo_is_skipped(self):
        (self.skills / "good/SKILL.md").write_text(GOOD.format(name="good") + "Upstream keeps `pstack/scripts/run.sh`.\n")
        code, out = self.run_checker()
        self.assertEqual(code, 0, out)

    def test_references_path_of_a_real_skill_is_checked(self):
        (self.skills / "good/SKILL.md").write_text(GOOD.format(name="good") + "See `other/references/gone.md`.\n")
        self.assert_fails("other/references/gone.md does not resolve")

    def test_unclosed_flow_sequence_fails(self):
        (self.skills / "good/SKILL.md").write_text("---\nname: good\ndescription: [unclosed\n---\n")
        self.assert_fails("frontmatter:")

    def test_colon_in_a_plain_description_fails(self):
        (self.skills / "good/SKILL.md").write_text("---\nname: good\ndescription: Use it: always\n---\n")
        self.assert_fails("frontmatter:")

    def test_skill_without_a_nix_line_fails(self):
        self.add_skill("unlinked", GOOD.format(name="unlinked").replace(", then `other/SKILL.md`", ""), link=False)
        (self.skills / "unlinked/references").mkdir()
        (self.skills / "unlinked/references/notes.md").write_text("notes\n")
        self.assert_fails("no home.file line")

    def test_nix_line_for_a_missing_skill_fails(self):
        self.link("renamed")
        self.assert_fails("renamed is not a directory")

    def test_name_that_does_not_match_the_directory_fails(self):
        (self.skills / "good/SKILL.md").write_text(GOOD.format(name="good").replace("name: good", "name: goods"))
        self.assert_fails("name 'goods' does not match the directory")

    def test_missing_license_fails(self):
        (self.skills / "good/LICENSE").unlink()
        self.assert_fails("no LICENSE")

    def test_nix_line_whose_source_and_target_differ_fails(self):
        line = 'home.file.".claude/skills/good".source = link "files/.claude/skills/good";'
        text = self.nix.read_text()
        self.assertIn(line, text)
        self.nix.write_text(text.replace(line, line.replace('link "files/.claude/skills/good"', 'link "files/.claude/skills/other"')))
        self.assert_fails("links .claude/skills/good to files/.claude/skills/other")

    # Repo-local skills (.claude/skills) register only inside the repo, so nix must not link them.
    def test_repo_local_skill_without_a_nix_line_passes(self):
        self.add_local("here", GOOD.format(name="here").replace("`references/notes.md`, then ", ""))
        code, out = self.run_checker(local=True)
        self.assertEqual(code, 0, out)
        self.assertIn("ok here (repo-local)", out)
        self.assertIn("repo-local listing:", out)

    def test_repo_local_skill_with_a_nix_line_fails(self):
        self.add_local("here", GOOD.format(name="here").replace("`references/notes.md`, then ", ""))
        self.link("here")
        self.assert_fails("is repo-local, so it needs no home.file line", local=True)

    def test_repo_local_skill_named_like_a_global_one_fails(self):
        self.add_local("good", GOOD.format(name="good").replace("`references/notes.md`, then ", ""))
        self.assert_fails("has the same name as a global skill", local=True)

    def test_repo_local_mention_of_a_missing_skill_fails(self):
        self.add_local("here", GOOD.format(name="here").replace("`references/notes.md`, then `other/SKILL.md`", "`hw/SKILL.md`"))
        self.assert_fails("hw/SKILL.md does not resolve", local=True)


if __name__ == "__main__":
    unittest.main()
