// Test-only: the session test preloads this into scripts/agent-chrome-session
// to hold the helper in the gap between starting the command and starting its
// watchdog, so a SIGKILL lands there every time instead of only under load.
// When the helper is about to spawn the watchdog, this writes the pid of the
// process spawned just before it (the command's group) to
// $AGENT_CHROME_SESSION_TEST_HOLD and blocks the helper until it is killed.
const childProcess = require("node:child_process");
const fs = require("node:fs");

const hold = process.env.AGENT_CHROME_SESSION_TEST_HOLD;
if (hold) {
  const spawn = childProcess.spawn;
  let last;
  childProcess.spawn = function (command, args, ...rest) {
    if (command === "/bin/sh" && Array.isArray(args) && /kill -s KILL/.test(args[1] ?? "")) {
      fs.writeFileSync(hold, String(last));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    const child = spawn.call(this, command, args, ...rest);
    last = child.pid;
    return child;
  };
}
