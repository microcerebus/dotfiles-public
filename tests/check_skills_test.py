#!/usr/bin/env python3
"""Tests for scripts/check-skills against a tiny skills tree.

Pure: no network, writes only to a temp dir.
Run: python3 -I tests/check_skills_test.py (needs PyYAML, like the checker).
CHECK_SKILLS=<path> runs the same cases against another copy of the checker.
"""
import importlib.machinery
import importlib.util
import os
import shutil
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
# A real CLAUDE_ONLY entry in scripts/check-skills.
CLAUDE_ONLY_SKILL = "codex-computer-use"
SIMPLE = GOOD.replace("`references/notes.md`, then `other/SKILL.md`", "the notes")


def claude_only():
    """The checker's CLAUDE_ONLY names, read from the copy under test."""
    loader = importlib.machinery.SourceFileLoader("check_skills", str(CHECKER))
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
    loader.exec_module(module)
    return set(module.CLAUDE_ONLY)


class CheckSkillsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.skills = self.root / "skills"
        self.nix = self.root / "user.nix"
        self.local = self.root / "repo-skills"
        self.agents = self.root / "agents-skills"
        self.add_skill("good", GOOD.format(name="good"))
        (self.skills / "good/references").mkdir()
        (self.skills / "good/references/notes.md").write_text("notes\n")
        self.add_skill("other", GOOD.format(name="other").replace(", then `other/SKILL.md`", ""))
        (self.skills / "other/references").mkdir()
        (self.skills / "other/references/notes.md").write_text("notes\n")

    def tearDown(self):
        self.tmp.cleanup()

    def add_skill(self, name, skill_md, link=True, codex=True):
        d = self.skills / name
        d.mkdir(parents=True)
        (d / "SKILL.md").write_text(skill_md, encoding="utf-8")
        (d / "LICENSE").write_text("MIT\n")
        if link:
            self.link(name)
        if codex:
            self.codex_link(name, name)

    def link(self, name):
        with self.nix.open("a") as f:
            f.write(f'  home.file.".claude/skills/{name}".source = link "files/.claude/skills/{name}";\n')

    def unlink_codex(self, name):
        lines = self.nix.read_text().splitlines(keepends=True) if self.nix.exists() else []
        self.nix.write_text("".join(l for l in lines if f'".agents/skills/{name}"' not in l))

    def run_checker(self, local=False):
        extra = ["--local", str(self.local), "--agents", str(self.agents)] if local else []
        r = subprocess.run([sys.executable, "-I", str(CHECKER), str(self.skills), "--nix", str(self.nix), *extra],
                           capture_output=True, text=True)
        return r.returncode, r.stdout + r.stderr

    def add_local(self, name, skill_md, codex=True):
        d = self.local / name
        d.mkdir(parents=True)
        (d / "SKILL.md").write_text(skill_md, encoding="utf-8")
        (d / "LICENSE").write_text("MIT\n")
        if codex:
            self.local_codex_link(name, name)

    def local_codex_link(self, name, target):
        """Point agents/<name> at repo-skills/<target>, like .agents/skills/<name>."""
        self.agents.mkdir(exist_ok=True)
        link = self.agents / name
        if link.is_symlink():
            link.unlink()
        link.symlink_to(f"../{self.local.name}/{target}")

    def add_codex_only(self, name, skill_md):
        """A real directory in agents/: a repo skill only Codex reads."""
        d = self.agents / name
        d.mkdir(parents=True)
        (d / "SKILL.md").write_text(skill_md, encoding="utf-8")
        (d / "LICENSE").write_text("MIT\n")

    def comment_out(self, line_part):
        text = self.nix.read_text()
        line = next(l for l in text.splitlines() if line_part in l)
        self.nix.write_text(text.replace(line, "  # " + line.strip()))

    def assert_fails(self, needle, local=False):
        code, out = self.run_checker(local)
        self.assertEqual(code, 1, out)
        self.assertIn(needle, out)

    def codex_link(self, name="good", source="good", policy=None):
        self.unlink_codex(name)
        with self.nix.open("a") as f:
            f.write(f'  home.file.".agents/skills/{name}".source = link "files/.claude/skills/{source}";\n')
        if policy is not None:
            d = self.skills / source / "agents"
            d.mkdir(exist_ok=True)
            (d / "openai.yaml").write_text(policy)

    def explicit_good(self):
        p = self.skills / "good/SKILL.md"
        p.write_text(p.read_text().replace("name: good", "name: good\ndisable-model-invocation: true"))

    def test_codex_explicit_skill_requires_matching_policy(self):
        self.explicit_good()
        self.codex_link()
        self.assert_fails("Codex invocation policy")

    def test_codex_policy_string_is_not_a_boolean(self):
        self.explicit_good()
        self.codex_link(policy='policy:\n  allow_implicit_invocation: "false"\n')
        self.assert_fails("Codex invocation policy")

    def test_codex_cannot_silently_enable_explicit_skill(self):
        self.explicit_good()
        self.codex_link(policy='policy:\n  allow_implicit_invocation: true\n')
        self.assert_fails("Codex invocation policy")

    def test_codex_alias_must_resolve_to_same_named_skill(self):
        self.codex_link(name="other")
        self.assert_fails("Codex link")

    # Codex reaches a skill only through its .agents/skills line.
    def test_skill_without_a_codex_line_fails(self):
        self.unlink_codex("other")
        self.assert_fails("no .agents/skills line for it in user.nix")

    def test_claude_only_skill_without_a_codex_line_passes(self):
        self.add_skill(CLAUDE_ONLY_SKILL, GOOD.format(name=CLAUDE_ONLY_SKILL).replace("`references/notes.md`, then ", ""), codex=False)
        code, out = self.run_checker()
        self.assertEqual(code, 0, out)

    def test_claude_only_skill_with_a_codex_line_fails(self):
        self.add_skill(CLAUDE_ONLY_SKILL, GOOD.format(name=CLAUDE_ONLY_SKILL).replace("`references/notes.md`, then ", ""))
        self.assert_fails("links it for Codex, but CLAUDE_ONLY")

    def test_codex_skill_naming_a_claude_only_skill_fails(self):
        self.add_skill(CLAUDE_ONLY_SKILL, GOOD.format(name=CLAUDE_ONLY_SKILL).replace("`references/notes.md`, then ", ""), codex=False)
        (self.skills / "good/SKILL.md").write_text(GOOD.format(name="good").replace("other/SKILL.md", f"{CLAUDE_ONLY_SKILL}/SKILL.md"))
        self.assert_fails(f"{CLAUDE_ONLY_SKILL}/SKILL.md, which Codex cannot read")

    def test_codex_skill_linking_a_claude_only_skill_fails(self):
        self.add_skill(CLAUDE_ONLY_SKILL, GOOD.format(name=CLAUDE_ONLY_SKILL).replace("`references/notes.md`, then ", ""), codex=False)
        (self.skills / "good/SKILL.md").write_text(GOOD.format(name="good") + f"See [it](../{CLAUDE_ONLY_SKILL}/SKILL.md).\n")
        self.assert_fails(f"../{CLAUDE_ONLY_SKILL}/SKILL.md, which Codex cannot read")

    def test_naming_a_claude_only_skill_gives_its_reason(self):
        self.add_skill(CLAUDE_ONLY_SKILL, SIMPLE.format(name=CLAUDE_ONLY_SKILL), codex=False)
        (self.skills / "good/SKILL.md").write_text(GOOD.format(name="good").replace("other/SKILL.md", f"{CLAUDE_ONLY_SKILL}/SKILL.md"))
        self.assert_fails(f"{CLAUDE_ONLY_SKILL} is CLAUDE_ONLY:")

    # A commented-out home.file line links nothing.
    def test_commented_out_codex_line_fails(self):
        self.comment_out('".agents/skills/other"')
        self.assert_fails("no .agents/skills line for it in user.nix")

    def test_commented_out_claude_line_fails(self):
        self.comment_out('".claude/skills/other"')
        self.assert_fails("no home.file line for it in user.nix")

    def test_codex_explicit_skill_with_false_policy_passes(self):
        self.explicit_good()
        self.codex_link(policy='policy:\n  allow_implicit_invocation: false\n')
        code, out = self.run_checker()
        self.assertEqual(code, 0, out)

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

    # Codex reads a repo-local skill through the repo's .agents/skills/<name> link.
    def test_repo_local_skill_without_a_codex_link_fails(self):
        self.add_local("here", SIMPLE.format(name="here"), codex=False)
        self.assert_fails("no Codex link", local=True)
        self.assert_fails("so Codex never sees it in this repo", local=True)

    def test_repo_local_codex_link_to_a_missing_target_fails(self):
        self.add_local("here", SIMPLE.format(name="here"))
        self.local_codex_link("here", "hereX")
        self.assert_fails("points at ../repo-skills/hereX", local=True)

    def test_repo_local_codex_link_to_another_skill_fails(self):
        self.add_local("here", SIMPLE.format(name="here"))
        self.add_local("there", SIMPLE.format(name="there"))
        self.local_codex_link("here", "there")
        self.assert_fails("points at ../repo-skills/there", local=True)

    def test_repo_local_claude_only_skill_with_a_codex_link_fails(self):
        self.add_local(CLAUDE_ONLY_SKILL, SIMPLE.format(name=CLAUDE_ONLY_SKILL))
        self.assert_fails("but CLAUDE_ONLY in scripts/check-skills keeps it", local=True)

    def test_repo_local_claude_only_skill_without_a_codex_link_passes(self):
        self.add_local(CLAUDE_ONLY_SKILL, SIMPLE.format(name=CLAUDE_ONLY_SKILL), codex=False)
        code, out = self.run_checker(local=True)
        self.assertEqual(code, 0, out)

    def test_repo_local_codex_skill_naming_a_claude_only_skill_fails(self):
        self.add_skill(CLAUDE_ONLY_SKILL, SIMPLE.format(name=CLAUDE_ONLY_SKILL), codex=False)
        self.add_local("here", SIMPLE.format(name="here").replace("the notes", f"`{CLAUDE_ONLY_SKILL}/SKILL.md`"))
        self.assert_fails(f"{CLAUDE_ONLY_SKILL}/SKILL.md, which Codex cannot read", local=True)

    def test_stray_file_in_codex_skills_fails(self):
        self.agents.mkdir()
        (self.agents / "notes").write_text("x\n")
        self.assert_fails("agents-skills/notes is a file", local=True)

    # A real directory in .agents/skills is a repo skill only Codex reads.
    def test_codex_only_repo_skill_passes(self):
        self.add_codex_only("solo", SIMPLE.format(name="solo"))
        code, out = self.run_checker(local=True)
        self.assertEqual(code, 0, out)
        self.assertIn("ok solo (repo-local, Codex only)", out)

    def test_codex_only_repo_skill_is_checked(self):
        self.add_codex_only("solo", SIMPLE.format(name="solo").replace("the notes", "`hw/SKILL.md`"))
        self.assert_fails("hw/SKILL.md does not resolve", local=True)

    def test_codex_only_repo_skill_without_a_license_fails(self):
        self.add_codex_only("solo", SIMPLE.format(name="solo"))
        (self.agents / "solo/LICENSE").unlink()
        self.assert_fails("no LICENSE", local=True)

    def test_codex_only_repo_skill_in_claude_only_fails(self):
        self.add_codex_only(CLAUDE_ONLY_SKILL, SIMPLE.format(name=CLAUDE_ONLY_SKILL))
        self.assert_fails("is a Codex-only skill, but CLAUDE_ONLY", local=True)

    def test_codex_only_repo_skill_named_like_a_global_one_fails(self):
        self.add_codex_only("good", SIMPLE.format(name="good"))
        self.assert_fails("has the same name as a global skill", local=True)


class RepoModeTest(unittest.TestCase):
    """The checker run with no arguments, from a copy laid out like this repo."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "scripts").mkdir()
        shutil.copy(CHECKER, self.root / "scripts/check-skills")
        (self.root / "nix").mkdir()
        lines = []
        for name in sorted(claude_only() | {"plain"}):
            self.skill(self.root / "files/.claude/skills" / name)
            lines.append(f'  home.file.".claude/skills/{name}".source = link "files/.claude/skills/{name}";')
        lines.append('  home.file.".agents/skills/plain".source = link "files/.claude/skills/plain";')
        (self.root / "nix/user.nix").write_text("\n".join(lines) + "\n")
        self.skill(self.root / ".claude/skills/here")
        (self.root / ".agents/skills").mkdir(parents=True)
        (self.root / ".agents/skills/here").symlink_to("../../.claude/skills/here")

    def tearDown(self):
        self.tmp.cleanup()

    def skill(self, d):
        d.mkdir(parents=True)
        (d / "SKILL.md").write_text(SIMPLE.format(name=d.name), encoding="utf-8")
        (d / "LICENSE").write_text("MIT\n")

    def run_checker(self):
        r = subprocess.run([sys.executable, "-I", str(self.root / "scripts/check-skills")], capture_output=True, text=True)
        return r.returncode, r.stdout + r.stderr

    def test_repo_tree_passes(self):
        code, out = self.run_checker()
        self.assertEqual(code, 0, out)
        self.assertIn("ok here (repo-local)", out)

    def test_deleted_repo_codex_link_fails(self):
        (self.root / ".agents/skills/here").unlink()
        code, out = self.run_checker()
        self.assertEqual(code, 1, out)
        self.assertIn("ln -s ../../.claude/skills/here .agents/skills/here", out)

    def test_dangling_repo_codex_link_fails(self):
        (self.root / ".agents/skills/here").unlink()
        (self.root / ".agents/skills/here").symlink_to("../../.claude/skills/hereX")
        code, out = self.run_checker()
        self.assertEqual(code, 1, out)
        self.assertIn("Codex link .agents/skills/here: points at ../../.claude/skills/hereX", out)

    def test_stale_claude_only_entry_fails(self):
        name = CLAUDE_ONLY_SKILL
        shutil.rmtree(self.root / "files/.claude/skills" / name)
        nix = self.root / "nix/user.nix"
        nix.write_text("".join(l for l in nix.read_text().splitlines(keepends=True) if f"/{name}\"" not in l))
        code, out = self.run_checker()
        self.assertEqual(code, 1, out)
        self.assertIn(f"CLAUDE_ONLY in scripts/check-skills names {name}, which is not a skill here", out)


if __name__ == "__main__":
    unittest.main()
