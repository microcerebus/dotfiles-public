# Self-hosted GitHub Actions runner for microcerebus/job-tracker.
# Actions' included minutes ran out on 2026-10-11 and the Actions budget stays
# at $0, so job-tracker's workflows run their jobs on this Mac instead. The
# required checks still come from Actions workflows; only the machine changes.
# Workflows target it with `runs-on: [self-hosted, job-tracker]`.
#
# Not nix-darwin's services.github-runners: that module asserts nix.enable,
# which Determinate Nix rules out (AGENTS.md), so this covers the same ground.
#
# Isolation: a hidden, non-admin user owns everything under /var/lib/github-runner.
# It cannot list or enter the owner's home, whatever groups macOS puts it in:
# a deny ACL that every activation re-applies. pf lets it reach nothing on the
# LAN or tailnet but DNS, this Mac's own tailnet address included:
# nix/github-runner.pf, kept loaded by the github-runner-firewall daemon. On
# every start and before every job the runner proves all that, plus no sudo
# and no trusted Nix, and runs no jobs if any of it fails. After every job a
# hook wipes the job's HOME, TMPDIR and work dir, the way a hosted runner
# starts each job on a fresh VM.
# Not covered: other users' listeners on this Mac's loopback and LAN
# addresses (the agent Chrome's DevTools, T3 Code, Lavish). macOS delivers
# that traffic without pf ever seeing it, so the runner can connect to them,
# and its check only warns. The owner accepted this on 2026-10-11: job-tracker
# is private, and the dependencies and PR code its jobs run already run as the
# owner in agent worktrees. Closing it would take a VM. Unix sockets and
# world-readable files outside the owner's home keep their own modes (a few
# sockets in /tmp are world-writable).
# Firewall off by hand, if it ever gets in the owner's way:
#   sudo pfctl -a com.apple/github-runner -F rules
#
# Registration: run `github-runner-register` as the owner, once after the first
# rebuild, and again if GitHub drops the runner (14 days offline). It mints a
# one-hour token with gh and drops it in the inbox; the service registers with
# it and deletes it. Lifecycle and tests: scripts/github-runner,
# tests/github_runner_test.sh.
#
# Logs: /var/log/github-runner/{github-runner,firewall}.log (readable by admin users).
{ lib, pkgs, username, hostname, ... }:

let
  user = "_github-runner";
  id = 533; # nix-darwin's default uid/gid for its own runner user
  root = "/var/lib/github-runner";
  inbox = "${root}/inbox";
  logDir = "/var/log/github-runner";
  pfRules = pkgs.writeText "github-runner.pf"
    (builtins.replaceStrings [ "@uid@" ] [ (toString id) ] (builtins.readFile ./github-runner.pf));

  conf = pkgs.writeText "github-runner.conf" ''
    url=https://github.com/microcerebus/job-tracker
    name=${hostname}
    labels=job-tracker
    bin=${pkgs.github-runner}/bin
    state=${root}/state
    work=${root}/work
    home=${root}/home
    tmp=${root}/tmp
    inbox=${inbox}
    protected=/Users/${username}
    anchor=com.apple/github-runner
    rules=${pfRules}
    loaded=/var/run/github-runner-firewall.loaded
  '';
  script = pkgs.writeShellScript "github-runner" (builtins.readFile ../scripts/github-runner);
  # The runner runs hooks as `bash -e <file>`, and only files named *.sh.
  jobStarted = pkgs.writeScript "github-runner-job-started.sh" ''
    exec ${script} job-started ${conf}
  '';
  jobCompleted = pkgs.writeScript "github-runner-job-completed.sh" ''
    exec ${script} job-completed ${conf}
  '';
  register = pkgs.writeShellScriptBin "github-runner-register" ''
    exec ${script} register ${conf}
  '';
in
{
  users.knownGroups = [ user ];
  users.groups.${user} = {
    gid = id;
    description = "GitHub Actions runner";
  };
  users.knownUsers = [ user ];
  users.users.${user} = {
    uid = id;
    gid = id;
    home = "${root}/home"; # nix-darwin cannot move an existing user's home
    shell = "/usr/bin/false";
    description = "GitHub Actions runner";
    isHidden = true;
  };

  environment.systemPackages = [ register ];

  # Runs after the users and groups scripts, before launchd loads the service.
  system.activationScripts.launchd.text = lib.mkBefore ''
    echo "setting up the GitHub Actions runner..." >&2
    mkdir -p ${root} ${logDir}
    chown root:wheel ${root}
    chmod 0755 ${root}
    for dir in state work home tmp; do
      mkdir -p ${root}/$dir
      chown ${user}:${user} ${root}/$dir
      chmod 0700 ${root}/$dir
    done
    # The owner drops registration tokens here; the runner reads and deletes them.
    mkdir -p ${inbox}
    chown ${username}:${user} ${inbox}
    chmod 0770 ${inbox}
    chown ${user}:admin ${logDir}
    chmod 0750 ${logDir}
    # The owner's home is 750 with group staff, and ~/.t3 and ~/orchestrator
    # are world-readable below it. The runner is not in staff today, but this
    # holds whatever groups it lands in. Replace, never stack, the entry.
    # /bin/chmod: coreutils' chmod, first on PATH here, knows no ACLs.
    ace="user:${user} deny list,search,add_file,add_subdirectory,delete_child,readattr,writeattr,readextattr,writeextattr,readsecurity,writesecurity,chown,delete"
    /bin/chmod -a "$ace" /Users/${username} 2>/dev/null || true
    /bin/chmod +a "$ace" /Users/${username} \
      || echo "warning: could not deny ${user} the home directory; the runner's check will refuse jobs if it can enter it" >&2
  '';

  launchd.daemons.github-runner = {
    command = "${script} start ${conf}";
    # What job-tracker's Verify jobs call besides Node and pnpm, which the repo
    # pins itself: git for checkout, python3, unzip, ffmpeg and ffprobe for the
    # recording checks, and Determinate's nix for the toolchain job. Google
    # Chrome is the system app from the google-chrome cask (nix/host.nix).
    path = (with pkgs; [ bash coreutils git gnutar gzip unzip python3 ffmpeg-headless ]) ++ [
      "/nix/var/nix/profiles/default/bin"
      "/usr/bin"
      "/bin"
      "/usr/sbin"
      "/sbin"
    ];
    environment = {
      LANG = "en_US.UTF-8";
      # nixpkgs ships the runner with Node 24 only (Node 20 is EOL), so
      # node20 actions such as checkout@v4 and setup-node@v4 run on it.
      FORCE_JAVASCRIPT_ACTIONS_TO_NODE24 = "true";
      ACTIONS_RUNNER_HOOK_JOB_STARTED = "${jobStarted}";
      ACTIONS_RUNNER_HOOK_JOB_COMPLETED = "${jobCompleted}";
    };
    serviceConfig = {
      Label = "com.${username}.github-runner";
      UserName = user;
      GroupName = user;
      RunAtLoad = true;
      # Restart after a failure. A clean exit means "waiting for a token",
      # and the inbox watch starts the service again when one lands.
      KeepAlive.SuccessfulExit = false;
      WatchPaths = [ inbox ];
      # Each failed start runs the isolation check, which asks sudo (logged),
      # so a broken runner retries once a minute, not every 10 seconds.
      ThrottleInterval = 60;
      ProcessType = "Interactive"; # no background CPU and I/O throttling for builds
      StandardOutPath = "${logDir}/github-runner.log";
      StandardErrorPath = "${logDir}/github-runner.log";
    };
  };

  # As root, every minute: load nix/github-runner.pf into its anchor and keep
  # pf enabled, so a reboot, a flush or `pfctl -d` heals within a minute.
  # Logs only what it changes.
  launchd.daemons.github-runner-firewall = {
    command = "${script} firewall ${conf}";
    path = [ "/usr/bin" "/bin" "/usr/sbin" "/sbin" ];
    serviceConfig = {
      Label = "com.${username}.github-runner-firewall";
      RunAtLoad = true;
      StartInterval = 60;
      StandardOutPath = "${logDir}/firewall.log";
      StandardErrorPath = "${logDir}/firewall.log";
    };
  };
}
