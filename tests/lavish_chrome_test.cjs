const { test } = require("node:test");
const assert = require("node:assert/strict");
const { run, sessionUrl } = require("../scripts/lavish-axi");
const output = 'session:\n  url: "http://test-machine.example.ts.net:4387/session/123abc"\n  status: opened\n';
const io = { stdout: { write() {} }, stderr: { write() {} } };
function recorder(response = output, openStatus = 0) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return command === "/usr/bin/open" ? { status: openStatus } : { status: 0, stdout: response, stderr: "" };
  };
  return { calls, spawn };
}
test("artifact disables upstream opener and opens only Google Chrome", () => {
  const { calls, spawn } = recorder();
  assert.equal(run(["review.html"], { BROWSER: "brave" }, spawn, io), 0);
  assert.equal(calls[0].options.env.LAVISH_AXI_NO_OPEN, "1");
  assert.deepEqual(calls[1].args, ["-b", "com.google.Chrome", "http://test-machine.example.ts.net:4387/session/123abc"]);
  assert.equal(calls[1].command, "/usr/bin/open");
  assert.equal(calls.length, 2);
});
test("explicit no-open never launches a browser", () => {
  for (const [args, env] of [[["review.html", "--no-open"], {}], [["review.html"], { LAVISH_AXI_NO_OPEN: "1" }]]) {
    const { calls, spawn } = recorder();
    assert.equal(run(args, env, spawn, io), 0);
    assert.equal(calls.length, 1);
  }
});
test("poll, replies and exports pass through without auto-opening", () => {
  for (const cmd of ["poll", "reply", "export", "share", "end"]) {
    const { calls, spawn } = recorder();
    assert.equal(run([cmd, "review.html"], {}, spawn, io), 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.stdio, "inherit");
  }
});
test("Chrome failure cannot fall back to the default browser", () => {
  const { calls, spawn } = recorder(output, 1);
  assert.equal(run(["review.html"], {}, spawn, io), 1);
  assert.equal(calls.length, 2);
});
test("ended review is not reopened", () => {
  const { calls, spawn } = recorder(output.replace("opened", "user-ended"));
  assert.equal(run(["review.html"], {}, spawn, io), 0);
  assert.equal(calls.length, 1);
});
test("only local or tailnet session URLs qualify", () => {
  assert.equal(sessionUrl(output), "http://test-machine.example.ts.net:4387/session/123abc");
  for (const url of ["https://example.com/session/123abc", "file:///session/123abc", "http://127.0.0.1/private"]) {
    assert.equal(sessionUrl(`url: "${url}"`), undefined);
  }
});
test("local-only links fail even when browser opening is disabled", () => {
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    for (const [args, env] of [[["review.html"], {}], [["review.html", "--no-open"], {}], [["review.html"], { LAVISH_AXI_NO_OPEN: "1" }]]) {
      const { calls, spawn } = recorder(output.replace("test-machine.example.ts.net", host));
      let stdout = "";
      let stderr = "";
      const captured = { stdout: { write(text) { stdout += text; } }, stderr: { write(text) { stderr += text; } } };
      assert.equal(run(args, env, spawn, captured), 1);
      assert.equal(calls.length, 1);
      assert.equal(stdout, "");
      assert.match(stderr, /Phone access requires a Tailscale MagicDNS URL/);
    }
  }
});
