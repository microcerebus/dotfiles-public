#!/usr/bin/env python3
"""Tests for scripts/packs-share: runs the real script against a temp packs root and state folder.

A stub stands in for the Vercel CLI. Its deploy copies the snapshot folder into a fake host, a loopback server that
answers like a Vercel deployment with directory listing off, and its remove deletes the copy, so publish and revoke
are checked end to end over HTTP without touching the network.
Run: python3 -I tests/packs_share_test.py
"""
import fcntl
import functools
import http.server
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / "scripts/packs-share"

VERCEL_STUB = r'''#!/usr/bin/env python3
import json, os, shutil, subprocess, sys
d = os.environ["STUB_DIR"]
args = sys.argv[1:]
with open(os.path.join(d, "calls"), "a") as f:
    f.write(json.dumps(args) + "\n")
project_file = os.path.join(d, "project.json")
project = json.load(open(project_file)) if os.path.exists(project_file) else None
if os.environ.get("STUB_FAIL") and args[0] == os.environ["STUB_FAIL"]:
    print("Error: the stub was told to fail", file=sys.stderr); sys.exit(1)
if args[0] == "api" and args[1].startswith("/v7/deployments"):
    deps = sorted(os.listdir(os.path.join(d, "host")))
    listed = [{"uid": "dpl_stub" + n.removeprefix("dep-"), "projectId": "prj_stub"} for n in deps]
    if os.environ.get("STUB_FOREIGN"):
        listed.append({"uid": "dpl_foreign", "projectId": "prj_other"})
    print(json.dumps({"deployments": listed}))
elif args[0] == "api" and "-X" not in args:
    if not project:
        print("Error: Project not found (404)", file=sys.stderr); sys.exit(1)
    print(json.dumps(project))
elif args[0] == "api" and args[args.index("-X") + 1] == "POST":
    if project:
        print("Error: A project with the name already exists (409)", file=sys.stderr); sys.exit(1)
    name = json.load(open(args[args.index("--input") + 1]))["name"]
    project = {"id": "prj_stub", "name": name, "accountId": "team_stub",
               "ssoProtection": {"deploymentType": "prod_deployment_urls_and_all_previews"},
               "directoryListing": True, "publicSource": None, "enablePreviewFeedback": None}
    json.dump(project, open(project_file, "w")); print(json.dumps(project))
elif args[0] == "api":
    project.update(json.load(open(args[args.index("--input") + 1])))
    json.dump(project, open(project_file, "w")); print(json.dumps(project))
elif args[0] == "deploy":
    n = sum(json.loads(line)[0] == "deploy" for line in open(os.path.join(d, "calls")))
    shutil.copytree(args[1], os.path.join(d, "host", f"dep-{n}"))
    print("Uploading...")
    if os.environ.get("STUB_DEPLOY_HANG"):
        # Like the real CLI, the work runs in a child process; it writes late.txt if it outlives a kill.
        late = os.path.join(d, f"late-{n}.txt")
        subprocess.run([sys.executable, "-c", "import sys, time; time.sleep(float(sys.argv[2])); "
                        "open(sys.argv[1], 'w').write('the child outlived its parent')",
                        late, os.environ["STUB_DEPLOY_HANG"]])
    if os.environ.get("STUB_PLACEHOLDER_INDEX"):
        open(os.path.join(d, "host", f"dep-{n}", "index.html"), "w").write("not a 404")
    if os.environ.get("STUB_DEPLOY_EXIT"):
        print("Error: the upload was cut off", file=sys.stderr); sys.exit(1)
    if os.environ.get("STUB_GARBLE"):
        print(f"Deployed dpl_stub{n}, but the answer is not JSON"); sys.exit(0)
    # Vercel CLI 64.5 with --non-interactive wraps the deployment like this (commands/deploy/index.js).
    target = os.environ.get("STUB_TARGET") or ("production" if "--prod" in args else None)
    print(json.dumps({"status": "ok", "deployment": {
        "id": f"dpl_stub{n}", "url": f"{os.environ['STUB_HOST']}/dep-{n}", "inspectorUrl": "https://vercel.example/i",
        "readyState": "READY", "target": target, "deploymentApiUrl": "https://api.vercel.example/d"},
        "message": "Deployment ready.", "next": [{"command": "vercel inspect"}]}, indent=2))
elif args[0] == "remove":
    if os.environ.get("STUB_REMOVE_FLAPS"):
        open(os.path.join(d, "flaps"), "w").write(os.environ["STUB_REMOVE_FLAPS"])
    shutil.rmtree(os.path.join(d, "host", "dep-" + args[1].removeprefix("dpl_stub")), ignore_errors=True)
'''


class FakeHost(http.server.SimpleHTTPRequestHandler):
    """A deployment as Vercel serves one with directory listing off: files and folder index.html, else 404."""

    def list_directory(self, path):
        self.send_error(404)

    def do_GET(self):
        # After a removal Vercel's edges disagree for a few seconds: answer the statuses queued in flaps first.
        flaps = Path(self.directory).parent / "flaps"
        queued = flaps.read_text().split() if flaps.exists() else []
        if queued:
            flaps.write_text(" ".join(queued[1:]))
            self.send_response(int(queued[0]))
            self.end_headers()
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("X-Robots-Tag", "noindex, nofollow")
        super().end_headers()

    def log_message(self, *args):
        pass


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.encode() if isinstance(text, str) else text)


class PacksShareTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="packs-share-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.stub_dir = self.tmp / "stub"
        (self.stub_dir / "host").mkdir(parents=True)
        stub = self.tmp / "vercel"
        stub.write_text(VERCEL_STUB)
        stub.chmod(0o755)
        server = http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0), functools.partial(FakeHost, directory=str(self.stub_dir / "host")))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.root = self.tmp / "packs"
        self.state = self.tmp / "state" / "packs-share"
        self.env = {"PATH": os.environ["PATH"], "HOME": str(self.tmp), "PACKS_ROOT": str(self.root),
                    "PACKS_SHARE_STATE": str(self.state), "PACKS_SHARE_VERCEL": str(stub),
                    "PACKS_SHARE_RETRY": "0.05", "STUB_DIR": str(self.stub_dir),
                    "STUB_HOST": f"http://127.0.0.1:{server.server_address[1]}"}
        self.make_pack()

    def make_pack(self):
        pack = self.root / "study"
        write(pack / "index.html", """<!DOCTYPE html><html><head><title>Study</title>
<link rel="stylesheet" href="style.css?v=2"><link rel="preconnect" href="https://fonts.example">
<script src="app.js" defer></script></head><body>
<img src="img/logo.png" srcset="img/logo.png 1x, img/logo@2x.png 2x">
<a href="page2.html#top">next</a> <a href="sub/">sub</a> <a href="#local">anchor</a> <a href="mailto:x@example.com">m</a>
<img src="data:image/png;base64,AAAA"> <img src="https://cdn.example/x.png">
<img src="/packs/study/abs.png"> <img src="../outside.txt"> <img src=".hidden/x.png"> <img src="missing.png">
<img src="link-out.txt"> <div style="background: url('img/inline.png')"></div>
<style>.hero { background: url(img/hero.png) }</style>
</body></html>""")
        write(pack / "style.css", '@import "base.css";\nbody { background: url("img/bg.png"); }\n')
        write(pack / "base.css", "p { color: red }\n")
        write(pack / "app.js", "console.log('hi')\n")
        for name in ("logo.png", "logo@2x.png", "bg.png", "inline.png", "hero.png", "x.svg"):
            write(pack / "img" / name, b"\x89PNG fake")
        write(pack / "page2.html", '<html><body><img src="img/x.svg"><a href="index.html">back</a></body></html>')
        write(pack / "sub" / "index.html", "<!doctype html><p>no head here</p>")
        write(pack / "secret.txt", "not referenced")
        write(pack / ".env", "TOKEN=nope")
        write(pack / ".git" / "config", "[core]")
        write(pack / ".hidden" / "x.png", b"hidden")
        write(pack / "abs.png", b"abs")
        write(self.root / "outside.txt", "outside the pack")
        (pack / "link-out.txt").symlink_to(self.root / "outside.txt")

    def run_share(self, *args, **env):
        result = subprocess.run([sys.executable, "-I", str(SCRIPT), *args], env={**self.env, **env},
                                capture_output=True, text=True, timeout=60)
        return result.returncode, result.stdout + result.stderr

    def calls(self):
        path = self.stub_dir / "calls"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def setup_project(self):
        code, out = self.run_share("setup", "--yes")
        self.assertEqual(code, 0, out)

    def dry_run(self, pack="study"):
        code, out = self.run_share(pack)
        self.assertEqual(code, 0, out)
        return out

    def publish(self, pack="study", **env):
        digest = re.search(rf"packs-share {pack} --yes ([0-9a-f]{{16}})$", self.dry_run(pack), re.M).group(1)
        return self.run_share(pack, "--yes", digest, **env)

    def listed(self, out):
        return set(re.findall(r"^  (\S+)\s+[\d.]+ [KM]?B$", out, re.M))

    def snapshot(self, pack):
        out_dir = self.tmp / f"snap-{pack}"
        code, out = self.run_share(pack, "--out", str(out_dir))
        self.assertEqual(code, 0, out)
        return out_dir / next(n for n in os.listdir(out_dir) if n != "vercel.json"), out

    EXPECTED = {"index.html", "style.css", "base.css", "app.js", "img/logo.png", "img/logo@2x.png", "img/bg.png",
                "img/inline.png", "img/hero.png", "page2.html", "img/x.svg", "sub/index.html"}

    def test_dry_run_lists_exactly_the_referenced_files_and_publishes_nothing(self):
        code, out = self.run_share("study")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.listed(out), self.EXPECTED)
        self.assertIn("12 files", out)
        for leftout in ("/packs/study/abs.png starts at the site root", "../outside.txt is outside the pack",
                        ".hidden/x.png is a dot path", "missing.png is missing", "link-out.txt links outside the pack"):
            self.assertIn(leftout, out)
        self.assertRegex(out, r"Dry run: nothing was published. To publish these files: "
                              r"packs-share study --yes [0-9a-f]{16}\n")
        self.assertEqual(self.calls(), [])

    def test_out_writes_the_exact_snapshot_folder(self):
        out_dir = self.tmp / "snap"
        code, out = self.run_share("study", "--out", str(out_dir))
        self.assertEqual(code, 0, out)
        top = sorted(os.listdir(out_dir))
        self.assertEqual(len(top), 2, top)
        token = next(n for n in top if n != "vercel.json")
        self.assertRegex(token, r"^[0-9a-f]{32}$")
        files = {str(p.relative_to(out_dir / token)) for p in (out_dir / token).rglob("*") if p.is_file()}
        self.assertEqual(files, self.EXPECTED)
        everything = [str(p.relative_to(out_dir)) for p in out_dir.rglob("*")]
        self.assertFalse([p for p in everything if any(part.startswith(".") for part in p.split("/"))])
        index = (out_dir / token / "index.html").read_text()
        self.assertTrue(index.startswith('<!DOCTYPE html><html><head>\n<meta name="robots" content="noindex, nofollow">'))
        self.assertIn('<meta name="referrer" content="no-referrer">', index)
        self.assertNotIn("notes", index.lower())
        self.assertTrue((out_dir / token / "sub/index.html").read_text().startswith("<!doctype html>\n<meta name=\"robots\""))
        self.assertEqual((out_dir / token / "style.css").read_bytes(), (self.root / "study/style.css").read_bytes())
        config = json.loads((out_dir / "vercel.json").read_text())
        keys = {h["key"]: h["value"] for h in config["headers"][0]["headers"]}
        self.assertEqual(config["headers"][0]["source"], "/(.*)")
        self.assertEqual(keys["X-Robots-Tag"], "noindex, nofollow")
        self.assertEqual(keys["Referrer-Policy"], "no-referrer")
        self.assertEqual(self.calls(), [])

    def test_warns_about_tailnet_names_and_local_paths(self):
        write(self.root / "study/base.css", "/* from /Users/someone/x on mac.tail0000.ts.net */\n")
        code, out = self.run_share("study")
        self.assertEqual(code, 0, out)
        self.assertIn("base.css mentions this Mac's tailnet name", out)
        self.assertIn("base.css mentions a local file path", out)

    def test_refuses_bad_names_and_packs_without_an_index(self):
        for name in ("../etc", ".hidden", "nope"):
            code, out = self.run_share(name)
            self.assertEqual(code, 2, out)
        code, out = self.run_share("study", "--out", str(self.tmp / "x"), "--yes")
        self.assertEqual(code, 2, out)

    def test_publish_needs_setup_first(self):
        code, out = self.publish()
        self.assertEqual(code, 2, out)
        self.assertIn("run packs-share setup", out)
        self.assertFalse([c for c in self.calls() if c[0] == "deploy"])

    def test_setup_without_yes_only_describes(self):
        code, out = self.run_share("setup")
        self.assertEqual(code, 0, out)
        self.assertIn("turns off Vercel Authentication", out)
        self.assertEqual(self.calls(), [])

    def test_setup_creates_and_opens_the_project_and_keeps_state_private(self):
        self.setup_project()
        self.assertIn(["api", "/v11/projects", "-X", "POST"], [c[:4] for c in self.calls()])
        self.assertFalse([c for c in self.calls() if c[0] == "project"])
        self.assertTrue(all(c[c.index("--scope") + 1] == "team_stub" for c in self.calls() if "--scope" in c))
        patch = json.loads((self.stub_dir / "project.json").read_text())
        self.assertIsNone(patch["ssoProtection"])
        self.assertIs(patch["directoryListing"], False)
        self.assertIs(patch["enablePreviewFeedback"], False)
        self.assertEqual(stat.S_IMODE(os.stat(self.state).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(self.state / "shares.json").st_mode), 0o600)
        self.assertIs(patch["publicSource"], False)
        saved = json.loads((self.state / "shares.json").read_text())["project"]
        self.assertEqual(saved, {"name": "packs-share", "id": "prj_stub", "scope": "team_stub",
                                 "production": "dpl_stub1"})
        deploy = next(c for c in self.calls() if c[0] == "deploy")
        self.assertIn("--prod", deploy)
        self.assertEqual(sorted(os.listdir(self.stub_dir / "host/dep-1")), ["404.html", "vercel.json"])
        self.assertIn("production serves only a 404 page", self.run_share("setup", "--yes")[1])
        self.assertEqual([c[:4] for c in self.calls()].count(["api", "/v11/projects", "-X", "POST"]), 1)
        self.assertEqual([c[0] for c in self.calls()].count("deploy"), 1)

    def test_publish_list_and_revoke_end_to_end(self):
        self.setup_project()
        code, out = self.publish()
        self.assertEqual(code, 0, out)
        deploy = [c for c in self.calls() if c[0] == "deploy"][-1]
        self.assertNotIn("--prod", deploy)
        self.assertEqual(deploy[deploy.index("--target") + 1], "preview")
        self.assertEqual(deploy[deploy.index("--project") + 1], "prj_stub")
        self.assertEqual(deploy[deploy.index("--scope") + 1], "team_stub")
        url = re.search(r"published study: (\S+)", out).group(1)
        self.assertRegex(url, r"/dep-2/[0-9a-f]{32}/$")
        self.assertIn("the share answers 200 without a login, the deployment root answers 404", out)
        self.assertEqual(stat.S_IMODE(os.stat(self.state / "shares.json").st_mode), 0o600)

        code, out = self.run_share("list")
        self.assertEqual(code, 0, out)
        self.assertRegex(out, r"^\d{4}-\d\d-\d\d \d\d:\d\d  study  " + re.escape(url) + "$")

        code, out = self.run_share("revoke", "study")
        self.assertEqual(code, 0, out)
        self.assertIn(["remove", "dpl_stub2", "--yes"], [c[:3] for c in self.calls()])
        self.assertIn("now answers 404", out)
        self.assertFalse((self.stub_dir / "host/dep-2").exists())
        self.assertEqual(self.run_share("list")[1].strip(), "no shares")

    def test_revoke_by_url_and_by_deployment_root(self):
        self.setup_project()
        urls = [re.search(r"published study: (\S+)", self.publish()[1]).group(1) for _ in range(2)]
        code, out = self.run_share("revoke", urls[0])
        self.assertEqual(code, 0, out)
        code, out = self.run_share("revoke", urls[1].rsplit("/", 2)[0])
        self.assertEqual(code, 0, out)
        self.assertEqual(self.run_share("list")[1].strip(), "no shares")
        code, out = self.run_share("revoke", "study")
        self.assertEqual(code, 2, out)

    def test_publish_refuses_a_project_that_would_not_be_public(self):
        self.setup_project()
        project = json.loads((self.stub_dir / "project.json").read_text())
        project["ssoProtection"] = {"deploymentType": "all_except_custom_domains"}
        (self.stub_dir / "project.json").write_text(json.dumps(project))
        code, out = self.publish()
        self.assertEqual(code, 2, out)
        self.assertIn("Vercel Authentication is on", out)
        self.assertEqual([c[0] for c in self.calls()].count("deploy"), 1)

    def test_revoke_waits_until_every_edge_stops_serving(self):
        self.setup_project()
        self.publish()
        code, out = self.run_share("revoke", "study", STUB_REMOVE_FLAPS="404 200 200")
        self.assertEqual(code, 0, out)
        self.assertIn("now answers 404", out)
        # A first 404 from one edge is not enough: revoke kept checking past the edges that still served.
        self.assertEqual((self.stub_dir / "flaps").read_text(), "")

    def test_revoke_keeps_the_record_when_the_host_still_serves(self):
        self.setup_project()
        self.publish()
        code, out = self.run_share("revoke", "study", STUB_FAIL="remove")
        self.assertEqual(code, 1, out)
        self.assertIn("study", self.run_share("list")[1])

    def test_revoke_drops_a_record_whose_copy_is_already_gone(self):
        self.setup_project()
        self.publish()
        shutil.rmtree(self.stub_dir / "host/dep-2")
        code, out = self.run_share("revoke", "study", STUB_FAIL="remove")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.run_share("list")[1].strip(), "no shares")

    def test_revoke_never_passes_anything_but_a_deployment_id(self):
        self.setup_project()
        self.publish()
        data = json.loads((self.state / "shares.json").read_text())
        data["shares"][0]["deployment"] = "packs-share"
        (self.state / "shares.json").write_text(json.dumps(data))
        code, out = self.run_share("revoke", "study")
        self.assertEqual(code, 2, out)
        self.assertFalse([c for c in self.calls() if c[0] == "remove"])

    # ---- round 1 review fixes ----

    def test_unreadable_deploy_answer_removes_the_stray_deployment(self):
        self.setup_project()
        code, out = self.publish(STUB_GARBLE="1")
        self.assertEqual(code, 2, out)
        self.assertIn("Removed the stray deployment dpl_stub2", out)
        self.assertIn(["remove", "dpl_stub2", "--yes"], [c[:3] for c in self.calls()])
        self.assertNotIn(["remove", "dpl_stub1", "--yes"], [c[:3] for c in self.calls()])
        self.assertFalse((self.stub_dir / "host/dep-2").exists())
        self.assertEqual(self.run_share("list")[1].strip(), "no shares")

    def test_a_share_that_lands_on_production_is_removed(self):
        self.setup_project()
        code, out = self.publish(STUB_TARGET="production")
        self.assertEqual(code, 2, out)
        self.assertIn("production deployment, so removed it", out)
        self.assertIsNone(json.loads((self.state / "shares.json").read_text())["project"]["production"])
        self.assertFalse((self.stub_dir / "host/dep-2").exists())
        self.assertTrue((self.stub_dir / "host/dep-1").exists())
        self.assertEqual(self.run_share("list")[1].strip(), "no shares")

    def test_publish_needs_the_production_placeholder(self):
        self.setup_project()
        data = json.loads((self.state / "shares.json").read_text())
        del data["project"]["production"]
        (self.state / "shares.json").write_text(json.dumps(data))
        code, out = self.publish()
        self.assertEqual(code, 2, out)
        self.assertIn("did not finish", out)
        self.assertEqual([c[0] for c in self.calls()].count("deploy"), 1)

    def test_revoke_never_removes_the_production_placeholder(self):
        self.setup_project()
        self.publish()
        data = json.loads((self.state / "shares.json").read_text())
        data["shares"][0]["deployment"] = "dpl_stub1"
        (self.state / "shares.json").write_text(json.dumps(data))
        code, out = self.run_share("revoke", "study")
        self.assertEqual(code, 2, out)
        self.assertFalse([c for c in self.calls() if c[0] == "remove"])

    def test_setup_refuses_a_project_it_did_not_make(self):
        theirs = {"id": "prj_theirs", "name": "packs-share", "accountId": "team_stub",
                  "ssoProtection": {"deploymentType": "all_except_custom_domains"}, "directoryListing": False}
        (self.stub_dir / "project.json").write_text(json.dumps(theirs))
        code, out = self.run_share("setup", "--yes")
        self.assertEqual(code, 2, out)
        self.assertIn("could not create a new Vercel project packs-share", out)
        self.assertEqual(json.loads((self.stub_dir / "project.json").read_text()), theirs)
        self.assertEqual([c[:4] for c in self.calls()], [["api", "/v11/projects", "-X", "POST"]])
        self.assertFalse((self.state / "shares.json").exists() and
                         json.loads((self.state / "shares.json").read_text())["project"])

    def test_publish_needs_the_digest_of_what_the_dry_run_showed(self):
        self.setup_project()
        digest = re.search(r"--yes ([0-9a-f]{16})$", self.dry_run(), re.M).group(1)
        code, out = self.run_share("study", "--yes")
        self.assertEqual(code, 2, out)
        self.assertIn("--yes takes the digest", out)
        write(self.root / "study/base.css", "p { color: blue }\n")
        code, out = self.run_share("study", "--yes", digest)
        self.assertEqual(code, 2, out)
        self.assertIn("is not what the dry run showed", out)
        self.assertEqual([c[0] for c in self.calls()].count("deploy"), 1)

    def test_publish_refuses_public_source_and_the_toolbar(self):
        self.setup_project()
        project = json.loads((self.stub_dir / "project.json").read_text())
        project.update(publicSource=True, enablePreviewFeedback=True)
        (self.stub_dir / "project.json").write_text(json.dumps(project))
        code, out = self.publish()
        self.assertEqual(code, 2, out)
        self.assertIn("build logs and source are public", out)
        self.assertIn("the preview toolbar is on", out)

    def test_links_inside_the_pack_to_dot_paths_stay_out(self):
        pack = self.root / "links"
        write(pack / ".env", "SECRET_ENV=1")
        write(pack / ".git" / "config", "[core]")
        (pack / "logo.png").symlink_to(".env")
        (pack / "assets").symlink_to(".git")
        write(pack / "ok.png", b"png")
        (pack / "alias.png").symlink_to("ok.png")
        write(pack / "index.html", '<img src="logo.png"><img src="assets/config"><img src="alias.png">')
        token_dir, out = self.snapshot("links")
        self.assertEqual(self.listed(out), {"index.html", "alias.png"})
        self.assertIn("logo.png links to a dot path, left out", out)
        self.assertIn("assets/config links to a dot path, left out", out)
        shipped = b"".join(p.read_bytes() for p in token_dir.rglob("*") if p.is_file())
        self.assertNotIn(b"SECRET_ENV", shipped)
        self.assertNotIn(b"[core]", shipped)

    def test_an_index_that_links_to_a_dot_file_is_refused(self):
        pack = self.root / "dotindex"
        write(pack / ".page.html", "<p>private</p>")
        pack.mkdir(exist_ok=True)
        (pack / "index.html").symlink_to(".page.html")
        code, out = self.run_share("dotindex")
        self.assertEqual(code, 2, out)
        self.assertIn("links to a dot path", out)

    def test_follows_js_imports_and_svg_refs_and_warns_about_runtime_loads(self):
        pack = self.root / "app"
        write(pack / "index.html", """<!doctype html><head>
<script type="module" src="js/app.js"></script>
<script type="module">import "./inline.js"; fetch("data/inline.json").then(r => r.json())</script>
</head><body><object data="pic.svg"></object></body>""")
        write(pack / "js/app.js", """import {f} from './dep.js';
export * from "../shared/more.mjs";
const w = new URL('worker.js', import.meta.url);
import('./lazy.js');
import 'lodash';
fetch('data.json');
""")
        for name in ("inline.js", "data/inline.json", "js/dep.js", "shared/more.mjs", "js/worker.js", "js/lazy.js",
                     "assets/i.png", "sprite.svg", "data.json", "unused.js"):
            write(pack / name, "x")
        write(pack / "pic.svg", '<svg xmlns="http://www.w3.org/2000/svg"><image href="assets/i.png"/>'
                                '<use xlink:href="sprite.svg#a"/></svg>')
        out = self.dry_run("app")
        self.assertEqual(self.listed(out), {"index.html", "js/app.js", "inline.js", "data/inline.json", "js/dep.js",
                                            "shared/more.mjs", "js/worker.js", "js/lazy.js", "pic.svg",
                                            "assets/i.png", "sprite.svg"})
        self.assertIn("js/app.js imports 'lodash', a package name the share cannot follow", out)
        self.assertIn("js/app.js loads files while it runs", out)
        self.assertNotIn("inline script) loads files while it runs", out)

    def test_meta_goes_in_the_real_head_and_the_page_referrer_meta_is_dropped(self):
        pack = self.root / "meta"
        write(pack / "index.html", '<!doctype html><!-- template: <head> goes here --><html><head>'
                                   '<meta name="referrer" content="unsafe-url"><title>x</title></head>'
                                   '<body><a href="Page.HTML">p</a></body></html>')
        write(pack / "Page.HTML",
              '<html><head></head><body><img src="hidden.png"> on mac.tail0000.ts.net</body></html>')
        write(pack / "hidden.png", b"png")
        token_dir, out = self.snapshot("meta")
        index = (token_dir / "index.html").read_text()
        self.assertIn("<!-- template: <head> goes here --><html><head>\n<meta name=\"robots\"", index)
        self.assertNotIn("unsafe-url", index)
        self.assertIn("index.html sets its own referrer policy; the share drops it", out)
        self.assertIn('<meta name="robots"', (token_dir / "Page.HTML").read_text())
        self.assertIn("hidden.png", self.listed(out))
        self.assertIn("Page.HTML mentions this Mac's tailnet name", out)

    def test_odd_references_are_warnings_not_crashes(self):
        pack = self.root / "odd"
        write(pack / "node_modules/lib/x.js", "x")
        write(pack / "index.html", '<base href="/packs/odd/"><script src="node_modules/lib/x.js"></script>'
                                   '<img src="a%00b"><img src="x.png" referrerpolicy="unsafe-url">')
        write(pack / "x.png", b"png")
        out = self.dry_run("odd")
        self.assertEqual(self.listed(out), {"index.html", "x.png"})
        self.assertIn("is under node_modules, which Vercel never uploads", out)
        self.assertIn("has a NUL character, left out", out)
        self.assertIn("index.html sets <base>", out)
        self.assertIn("referrerpolicy=unsafe-url", out)

    def test_refuses_case_collisions_an_out_file_and_a_corrupt_state_file(self):
        pack = self.root / "cases"
        write(pack / "Style.css", "a")
        write(pack / "style.css", "b")
        write(pack / "index.html", '<link href="Style.css" rel="stylesheet"><link href="style.css" rel="stylesheet">')
        code, out = self.run_share("cases")
        self.assertEqual(code, 2, out)
        self.assertIn("differ only in case", out)
        write(self.tmp / "afile", "x")
        code, out = self.run_share("study", "--out", str(self.tmp / "afile"))
        self.assertEqual(code, 2, out)
        self.assertIn("is not an empty folder", out)
        write(self.state / "shares.json", "{not json")
        code, out = self.run_share("list")
        self.assertEqual(code, 2, out)
        self.assertNotIn("Traceback", out)

    def test_a_failed_deploy_removes_what_it_left_on_the_host(self):
        self.setup_project()
        self.publish()
        code, out = self.publish(STUB_DEPLOY_EXIT="1", STUB_FOREIGN="1")
        self.assertEqual(code, 2, out)
        self.assertIn("Removed the stray deployment dpl_stub3", out)
        removed = [c[1] for c in self.calls() if c[0] == "remove"]
        self.assertEqual(removed, ["dpl_stub3"])
        self.assertTrue((self.stub_dir / "host/dep-1").exists())
        self.assertTrue((self.stub_dir / "host/dep-2").exists())
        self.assertEqual(json.loads((self.state / "shares.json").read_text())["pending"], [])

    def test_a_timed_out_deploy_stops_the_whole_cli_and_removes_its_deployment(self):
        self.setup_project()
        code, out = self.publish(STUB_DEPLOY_HANG="1.5", PACKS_SHARE_TIMEOUT="0.3")
        self.assertEqual(code, 2, out)
        self.assertIn("took longer than 0.3 seconds", out)
        self.assertIn("Removed the stray deployment dpl_stub2", out)
        time.sleep(2)
        self.assertFalse((self.stub_dir / "late-2.txt").exists(), "the CLI's child kept running after the timeout")
        self.assertEqual(json.loads((self.state / "shares.json").read_text())["pending"], [])

    def test_a_run_killed_mid_deploy_is_swept_by_the_next_run(self):
        self.setup_project()
        digest = re.search(r"--yes ([0-9a-f]{16})$", self.dry_run(), re.M).group(1)
        killed = subprocess.Popen([sys.executable, "-I", str(SCRIPT), "study", "--yes", digest],
                                  env={**self.env, "STUB_DEPLOY_HANG": "2"}, stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL)
        deadline = time.time() + 10
        while not (self.stub_dir / "host/dep-2").exists() and time.time() < deadline:
            time.sleep(0.05)
        killed.kill()
        killed.wait()
        # Its vercel process may still be uploading, so the next run refuses until it is done.
        code, out = self.publish()
        self.assertEqual(code, 2, out)
        self.assertIn("is still running", out)
        while not (self.stub_dir / "late-2.txt").exists() and time.time() < deadline:
            time.sleep(0.05)
        time.sleep(0.3)
        code, out = self.publish()
        self.assertEqual(code, 0, out)
        self.assertIn("An earlier publish was cut off mid-deploy. Removed the stray deployment dpl_stub2", out)
        self.assertFalse((self.stub_dir / "host/dep-2").exists())
        data = json.loads((self.state / "shares.json").read_text())
        self.assertEqual(data["pending"], [])
        self.assertEqual([s["deployment"] for s in data["shares"]], ["dpl_stub3"])

    def test_only_one_run_talks_to_the_host_at_a_time(self):
        self.setup_project()
        with open(self.state / "run.lock", "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            code, out = self.publish()
        self.assertEqual(code, 2, out)
        self.assertIn("another packs-share publish, revoke or setup is running", out)
        self.assertEqual(len([c for c in self.calls() if c[0] == "deploy"]), 1, "only setup's placeholder deployed")

    def test_setup_removes_a_placeholder_that_is_not_a_production_404(self):
        for env in ({"STUB_TARGET": "preview"}, {"STUB_PLACEHOLDER_INDEX": "1"}):
            code, out = self.run_share("setup", "--yes", **env)
            self.assertEqual(code, 2, out)
            self.assertIn("so setup removed it", out)
            self.assertEqual(os.listdir(self.stub_dir / "host"), [])
            self.assertIsNone(json.loads((self.state / "shares.json").read_text())["project"].get("production"))
        self.setup_project()

    def test_hard_links_and_hidden_metas_stay_out(self):
        pack = self.root / "tricks"
        write(self.root / "outside.txt", "outside the pack")
        pack.mkdir(parents=True)
        os.link(self.root / "outside.txt", pack / "hard.txt")
        write(pack / "index.html", '<a href="hard.txt">h</a>')
        out = self.dry_run("tricks")
        self.assertEqual(self.listed(out), {"index.html"})
        self.assertIn("hard.txt has other hard links", out)
        for head in ('<html data-x="<head>"><head></head>', '<head><meta name="&#114;eferrer" content="unsafe-url">',
                     '<body><svg><style><meta name="referrer" content="unsafe-url"></style></svg>'):
            write(pack / "index.html", head)
            code, out = self.run_share("tricks")
            self.assertEqual(code, 2, out)
            self.assertIn("simplify the page's head", out)


if __name__ == "__main__":
    unittest.main()
