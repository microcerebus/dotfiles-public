const { test } = require("node:test");
const assert = require("node:assert/strict");
const { run } = require("../scripts/agent-chrome-playwright");

function harness({ ready = true, identityError = null, attach = true } = {}) {
  const calls = [];
  let marker;
  const page = { url: () => marker };
  const session = { send: async (method, args) => {
    calls.push([method, args]);
    if (method === "Target.createTarget") { marker = args.url; return { targetId: "own-target" }; }
  } };
  const deps = {
    ready: () => { calls.push("ready"); return ready; },
    identityError: () => identityError,
    connect: async () => {
      calls.push("connect");
      return {
        contexts: () => [{ pages: () => attach ? [{ url: () => "https://other-tab.example" }, page] : [] }],
        newBrowserCDPSession: async () => session,
        close: async () => { calls.push("disconnect"); },
      };
    },
    sleep: async () => {},
  };
  return { calls, page, deps };
}

test("a written flow gets only its own background tab and closes that target before disconnecting", async () => {
  const { calls, page, deps } = harness();
  assert.equal(await run(async (actual) => { assert.equal(actual, page); return "read"; }, deps), "read");
  assert.deepEqual(calls.slice(0, 2), ["ready", "connect"]);
  assert.equal(calls[2][0], "Target.createTarget");
  assert.equal(calls[2][1].background, true);
  assert.deepEqual(calls.slice(-2), [["Target.closeTarget", { targetId: "own-target" }], "disconnect"]);
});

test("failed flows and attachment timeouts still clean up only the owned tab", async () => {
  for (const attach of [true, false]) {
    const { calls, deps } = harness({ attach });
    await assert.rejects(run(async () => { throw new Error("failed flow"); }, deps), attach ? /failed flow/ : /did not attach/);
    assert.deepEqual(calls.slice(-2), [["Target.closeTarget", { targetId: "own-target" }], "disconnect"]);
  }
});

test("Chrome readiness and application identity failures refuse before connecting", async () => {
  for (const options of [{ ready: false }, { identityError: "not Google Chrome Beta with safe flags" }]) {
    const { calls, deps } = harness(options);
    await assert.rejects(run(async () => assert.fail("must not drive"), deps));
    assert.deepEqual(calls, ["ready"]);
  }
});
