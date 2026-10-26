// github-runner-hook.js: the job hooks of the self-hosted runner that
// nix/github-runner.nix declares. Each hook file the runner is given is one
// line that calls this with { command, script, config, env }.
//
// Why .js and not .sh: the runner runs a .sh hook as `bash -e <file>` with
// whatever bash comes first on its PATH, and a job's GITHUB_PATH entries
// come first. So a job could put its own bash there, which the job-completed
// hook would then run instead of the wipe. A .js hook runs under the
// runner's own Node, by absolute path in the store. This then runs the
// script by absolute path with only the environment it is given, so no
// BASH_ENV, ENV, SHELLOPTS, BASHOPTS or PS4 from the hook's environment
// reaches the script's bash.
// Tests: tests/github_runner_test.sh
'use strict';
const { spawnSync } = require('node:child_process');

module.exports = ({ command, script, config, env }) => {
  const run = spawnSync(script, [command, config], { env, stdio: 'inherit' });
  if (run.error) {
    console.error(`github-runner ${command}: ${run.error.message}`);
    process.exit(1);
  }
  // A script killed by a signal has no status: the hook fails.
  process.exit(run.status ?? 1);
};
