// Test-only: the session test preloads this into scripts/agent-chrome-session
// to make a second signal's group SIGKILL land the way XNU's killpg can under
// fork-heavy load: one member at a time, newest first, so the command's shell
// sees its child die and exits 0 before its own SIGKILL arrives.
// On process.kill(-group, "SIGKILL") this SIGKILLs the grandchild whose pid is
// in $AGENT_CHROME_SESSION_TEST_SPLIT_KILL, waits until the group's leader is a
// zombie or gone, then sends the real killpg to the same group. The group and
// the signal are unchanged; only the order the members die in is.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

const file = process.env.AGENT_CHROME_SESSION_TEST_SPLIT_KILL;
if (file) {
  const kill = process.kill.bind(process);
  const ps = (field, pid) => spawnSync("/bin/ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  const ownGroup = Number(ps("pgid", process.pid));
  process.kill = function (pid, signal) {
    const group = -pid;
    if (Number.isInteger(pid) && group > 1 && group !== ownGroup && (signal === "SIGKILL" || signal === 9)) {
      const grandchild = Number(fs.readFileSync(file, "utf8"));
      // Only a member of the group the helper is about to kill anyway. Else
      // kill the group whole and exit 70, which no test takes for a stop.
      if (!(Number.isInteger(grandchild) && grandchild > 1 && Number(ps("pgid", grandchild)) === group)) {
        process.stderr.write(`split-kill: ${grandchild} is not in group ${group}\n`);
        kill(pid, signal);
        process.exit(70);
      }
      kill(grandchild, "SIGKILL");
      for (;;) {
        const stat = ps("stat", group);
        if (!stat || stat.startsWith("Z")) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    return kill(pid, signal);
  };
}
