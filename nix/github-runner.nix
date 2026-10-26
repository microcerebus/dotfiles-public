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
# starts each job on a fresh VM. It first lifts the user flags uchg and
# uappnd, ACLs and closed modes across those trees, never through a symlink,
# down to paths longer than PATH_MAX whatever the names' encoding. Then it
# deletes everything but the runner's own _temp and _PipelineMapping.
# Afterwards it lists what is left: only containermanagerd's two directories
# in the home (Library/ContainerManager and
# Library/Caches/com.apple.containermanagerd), the directories on the way to
# them, and Library/Preferences and Library/Application Support, emptied, may
# stay. Their extended attributes, and those of HOME, TMPDIR and the work
# dir, are cleared, all but containermanagerd's. Anything else left fails the
# hook, so the job that left it fails instead of passing. The hook wipes all
# three dirs before it fails, so the next job, which still runs (job-started
# does not check again), gets only what could not be wiped. A wipe that
# succeeds sets each dir back to 0700.
# Not covered: a process the job leaves running. It can write into HOME,
# TMPDIR or the work dir again after the wipe, or relock files while the
# wipe runs (which then fails the hook).
# Tool cache: the job-started hook copies the Node that job-tracker pins from
# the Nix store into the job's tool cache, so setup-node finds it there and
# needs no network (toolSeed below). Jobs get a copy; the store original is
# root-owned and read-only, so no job can change the seed itself. Each job
# gets a fresh copy: before copying, job-started lifts the same locks on the
# tool cache, deletes the old copy and any link on the way to it, and
# refuses the job if it cannot.
# Seatbelt: the runner and every job run under sandbox-exec with a profile
# that allows everything but TCP connections to the ports in denyPorts below,
# the owner's listeners on this Mac's loopback and LAN addresses, which macOS
# delivers without pf ever seeing them. It also denies canaryPort, where the
# check starts a listener of its own and then must fail to connect, so a
# runner outside the seatbelt runs no jobs whether or not any denied listener
# is up. sudo is checked before the seatbelt, which would refuse it whatever
# sudoers says. The profile also denies new launchd jobs, which launchd would
# start outside the seatbelt. A runner whose starts keep failing (a broken
# check or seatbelt, or a listener that exits non-zero or is killed by a
# signal) is an alarm in `dotfiles-autoupdate status` after 5 minutes,
# through reload.status (see Switches). A run that fails seconds after it
# starts counts too, as each poll compares launchd's count of runs with the
# last poll's. A listener that stays up for more than a poll before each
# crash clears the note in between, so it may never alarm.
# The profile and its limits:
# `seatbelt` in scripts/github-runner.
# Not covered: other users' listeners on those addresses on any other port.
# The runner can connect to them, and its check only warns. The owner
# accepted this on 2026-10-11: job-tracker is private, and the dependencies
# and PR code its jobs run already run as the owner in agent worktrees.
# Closing it would take a VM. Unix sockets and world-readable files outside
# the owner's home keep their own modes (a few sockets in /tmp are
# world-writable).
# Switches: a switch that changes the runner's plist does not reload a
# running runner, which would kill its job. Activation installs the plist and
# leaves the reload pending (/var/run/github-runner-reload.pending, which a
# reboot clears); the github-runner-firewall daemon reloads the runner once
# two of its polls at least a minute apart found no job running. A reload
# that fails, or one still pending after 2 hours, is an alarm in
# `dotfiles-autoupdate status` (/var/lib/github-runner/reload.status). A
# runner that is not loaded is loaded at once, as before. The daemon leaves a
# runner stopped by hand stopped, but nix-darwin still loads it (`launchctl
# load -w`) at the next switch that changes its plist.
# Firewall off by hand, if it ever gets in the owner's way:
#   sudo pfctl -a com.apple/github-runner -F rules
#
# Registration: run `github-runner-register` as the owner, once after the first
# rebuild, and again if GitHub drops the runner (14 days offline). It mints a
# one-hour token with gh and drops it in the inbox; the service registers with
# it and deletes it. Lifecycle and tests: scripts/github-runner,
# tests/github_runner_test.sh.
#
# Logs (readable by admin users): the runner's in
# /var/log/github-runner/github-runner.log, the github-runner-firewall daemon's
# in /var/log/github-runner-firewall.log. That daemon runs as root, so its log
# stays out of the runner's log dir: the runner owns that dir, could swap the
# log for a symlink, and root would then write to whatever file it names.
{ config, lib, pkgs, username, hostname, ... }:

let
  user = "_github-runner";
  id = 533; # nix-darwin's default uid/gid for its own runner user
  root = "/var/lib/github-runner";
  inbox = "${root}/inbox";
  evidence = "${root}/evidence";
  logDir = "/var/log/github-runner";
  runnerLog = "${logDir}/github-runner.log";
  firewallLog = "/var/log/github-runner-firewall.log";
  label = "com.${username}.github-runner";
  # The runner's default (work/_tool), set explicitly so the hook and the
  # runner agree. Inside work, so every job's wipe clears it.
  toolCache = "${root}/work/_tool";
  # The runner's PATH: what job-tracker's Verify jobs call besides Node and
  # pnpm, which the repo pins itself: git for checkout, python3, unzip, ffmpeg
  # and ffprobe for the recording checks, and Determinate's nix for the
  # toolchain job. Google Chrome is the system app from the google-chrome cask
  # (nix/host.nix). Joined the way nix-darwin joins a daemon's `path`, so the
  # hooks run the script with the same PATH as the plist.
  runnerPath = lib.concatMapStringsSep ":" (p: if lib.isDerivation p then "${p}/bin" else p)
    ((with pkgs; [ bash coreutils git gnutar gzip unzip python3 ffmpeg-headless ]) ++ [
      "/nix/var/nix/profiles/default/bin"
      "/usr/bin"
      "/bin"
      "/usr/sbin"
      "/sbin"
    ]);

  # The Node that job-tracker's .node-version names. Bump both together: set
  # version, then hash to `nix hash convert --hash-algo sha256 <hex>` of the
  # darwin-arm64 line in https://nodejs.org/dist/v<version>/SHASUMS256.txt. If they drift,
  # setup-node misses the cache and downloads the job's version as before.
  node = {
    version = "22.23.2";
    hash = "sha256-YRMPOUwWMNIR3VCuzENT03lIDzbTrJE82F27oa7VhcY=";
  };
  # Laid out the way @actions/tool-cache looks for a tool:
  # <tool>/<version>/<arch>, plus <arch>.complete beside it. arm64 is what
  # setup-node's os.arch() reports on this Apple silicon Mac. runCommand runs
  # no fixup, so the binaries stay byte for byte (and signed) as released.
  toolSeed = pkgs.runCommand "github-runner-tool-seed" {
    src = pkgs.fetchurl {
      url = "https://nodejs.org/dist/v${node.version}/node-v${node.version}-darwin-arm64.tar.gz";
      inherit (node) hash;
    };
  } ''
    mkdir -p $out/node/${node.version}
    tar -xzf $src -C $out/node/${node.version}
    mv $out/node/${node.version}/node-v${node.version}-darwin-arm64 $out/node/${node.version}/arm64
    touch $out/node/${node.version}/arm64.complete
  '';
  # What the seatbelt denies jobs: the agent Chrome's gate (9333) and its raw
  # DevTools port (9334), the owner's own Chrome (9222), T3 Code (3773), the
  # packs server (4391), the agent board (4790) and Raycast's backend (7265).
  # job-tracker's CI uses none of them.
  denyPorts = [ 9222 9333 9334 3773 4391 4790 7265 ];
  # Denied too, and used by nothing else: the isolation check's own canary.
  canaryPort = 9336;
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
    tool=${toolCache}
    seed=${toolSeed}
    inbox=${inbox}
    protected=/Users/${username}
    anchor=com.apple/github-runner
    rules=${pfRules}
    loaded=/var/run/github-runner-firewall.loaded
    user=${user}
    label=${label}
    plist=/Library/LaunchDaemons/${label}.plist
    reload=/var/run/github-runner-reload
    reload_status=${root}/reload.status
    deny_ports=${lib.concatMapStringsSep "," toString denyPorts}
    canary_port=${toString canaryPort}
    log=${runnerLog}
  '';
  script = pkgs.writeShellScript "github-runner" (builtins.readFile ../scripts/github-runner);
  # The runner runs a *.sh hook as `bash -e <file>` with the first bash on
  # its PATH, where a job's GITHUB_PATH entries come first, and a *.js hook
  # with its own Node, by absolute path. So the hooks are *.js, which run the
  # script with the plist's PATH and nothing else from the hook's
  # environment (scripts/github-runner-hook.js). The *.js case is in the
  # runner's source (2.338, HostContext.GetDefaultShellForScript), not its
  # docs. A runner that drops it throws on the hook, which fails the job,
  # but steps with `if: always()` still run and no job is wiped. One that
  # resolved `node` on PATH would fail every job-started hook, as no node
  # is on the runner's PATH. A runner bump should re-read that function.
  hook = command: pkgs.writeText "github-runner-${command}.js" ''
    require(${builtins.toJSON "${../scripts/github-runner-hook.js}"})(${builtins.toJSON {
      inherit command;
      script = "${script}";
      config = "${conf}";
      env = {
        PATH = runnerPath;
        HOME = "${root}/home";
        TMPDIR = "${root}/tmp";
        LANG = "en_US.UTF-8";
      };
    }});
  '';
  jobStarted = hook "job-started";
  jobCompleted = hook "job-completed";
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
    # job-tracker's CI keeps evidence and receipts here instead of uploading
    # them (its JOB_TRACKER_EVIDENCE_STORE) and prunes it itself: 3 days, 40 GB.
    # Group staff, so the owner can review it; job wipes leave it alone.
    mkdir -p ${evidence}
    chown ${user}:staff ${evidence}
    chmod 2750 ${evidence}
    # The owner drops registration tokens here; the runner reads and deletes them.
    mkdir -p ${inbox}
    chown ${username}:${user} ${inbox}
    chmod 0770 ${inbox}
    chown ${user}:admin ${logDir}
    chmod 0750 ${logDir}
    touch ${firewallLog}
    chown root:admin ${firewallLog}
    chmod 0640 ${firewallLog}
    # The firewall daemon's old log, from before it left the runner's dir.
    # rm takes a symlink there away without following it. A job can leave a
    # directory or an immutable file there instead, so a failure only warns:
    # under set -e it would abort every switch from here on.
    rm -f ${logDir}/firewall.log \
      || echo "warning: could not remove ${logDir}/firewall.log; root no longer writes there" >&2
    # The owner's home is 750 with group staff, and ~/.t3 and ~/orchestrator
    # are world-readable below it. The runner is not in staff today, but this
    # holds whatever groups it lands in. Replace, never stack, the entry.
    # /bin/chmod: coreutils' chmod, first on PATH here, knows no ACLs.
    ace="user:${user} deny list,search,add_file,add_subdirectory,delete_child,readattr,writeattr,readextattr,writeextattr,readsecurity,writesecurity,chown,delete"
    /bin/chmod -a "$ace" /Users/${username} 2>/dev/null || true
    /bin/chmod +a "$ace" /Users/${username} \
      || echo "warning: could not deny ${user} the home directory; the runner's check will refuse jobs if it can enter it" >&2
    # Before nix-darwin's launchd step below, which would reload the runner
    # straight away. If this fails, that step reloads it as it always did.
    ${script} activate ${conf} ${config.system.build.launchd}/Library/LaunchDaemons/${label}.plist \
      || echo "warning: could not defer the runner's reload; nix-darwin reloads it now" >&2
  '';

  launchd.daemons.github-runner = {
    command = "${script} start ${conf}";
    path = [ runnerPath ];
    environment = {
      LANG = "en_US.UTF-8";
      # nixpkgs ships the runner with Node 24 only (Node 20 is EOL), so
      # node20 actions such as checkout@v4 and setup-node@v4 run on it.
      FORCE_JAVASCRIPT_ACTIONS_TO_NODE24 = "true";
      ACTIONS_RUNNER_HOOK_JOB_STARTED = "${jobStarted}";
      ACTIONS_RUNNER_HOOK_JOB_COMPLETED = "${jobCompleted}";
      RUNNER_TOOL_CACHE = toolCache;
    };
    serviceConfig = {
      Label = label;
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
      StandardOutPath = runnerLog;
      StandardErrorPath = runnerLog;
    };
  };

  # As root, every minute: reload the runner if a switch left a reload
  # pending and it is idle, load nix/github-runner.pf into its anchor and
  # keep pf enabled, so a reboot, a flush or `pfctl -d` heals within a
  # minute. Logs only what it changes.
  launchd.daemons.github-runner-firewall = {
    command = "${script} firewall ${conf}";
    path = [ "/usr/bin" "/bin" "/usr/sbin" "/sbin" ];
    serviceConfig = {
      Label = "com.${username}.github-runner-firewall";
      RunAtLoad = true;
      StartInterval = 60;
      StandardOutPath = firewallLog;
      StandardErrorPath = firewallLog;
    };
  };
}
