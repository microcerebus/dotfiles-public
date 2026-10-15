# Wakes the Mac before each fixed-time T3 Code task and keeps it awake through
# the run. Script and tests: scripts/wake-schedule, tests/wake_schedule_test.sh.
#
# Why: the 08:00 daily job list missed 13, 14 and 15 Oct 2026. On the 14th and
# 15th the lid was closed and the Mac asleep ("Clamshell Sleep" in
# `pmset -g log`), waking only for a few seconds at a time for maintenance.
# T3 checks for due tasks every 5 seconds of awake time and skips a fixed-time
# run that is more than 10 minutes late (MISSED_FIXED_TIME_GRACE_MS in its
# server): on the 15th a maintenance wake at 08:10:10 found the 08:00 slot
# 10 min 10 s old and moved it to the next day. On the 13th the Mac was shut
# down. Any wake fires a due task, but firing only queues the prompt: the
# agent turn then needs the Mac awake for 3.5 to 7 minutes (the list and the
# checks, 10-15 Oct). The 10:00 check on the 15th fired in a maintenance wake
# and its turn took 15 minutes, most of them asleep.
#
# How: a root daemon keeps one-off `pmset schedule wake` events queued
# leadMinutes before each slot, three days ahead, and at each wake time turns
# SleepDisabled on until holdMinutes after the slot. Only SleepDisabled keeps a
# closed MacBook awake: caffeinate-style assertions do not, and on battery
# nothing else does. The daemon turns it back off only if it turned it on, so
# a value set by hand for a night of work stays; setting it by hand *during* a
# hold is undone when the hold ends. It holds nothing on battery below 15%.
#
# Not covered: a Mac that is shut down. FileVault is on, so a scheduled power-on
# would stop at the unlock screen, where T3 cannot run; hence `wake`, not
# `wakeorpoweron`. T3 Code itself must be running.
#
# Keep `slots` in step with T3's fixed-time tasks. The orchestrator's overnight
# preflight warns about any task without a wake queued before its next run.
# Log: /var/log/wake-schedule.log. Queued wakes: `pmset -g sched`.
{ lib, pkgs, username, ... }:

let
  # T3's fixed-time tasks: timeOfDay, and weekdays as T3 numbers them
  # (0 = Sunday); no weekdays means daily.
  slots = [
    { at = "08:00"; }                   # daily job list
    { at = "09:00"; weekdays = [ 0 ]; } # weekly export
    { at = "10:00"; }                   # morning check
    { at = "18:00"; }                   # evening check
  ];
  leadMinutes = 5;
  # The longest scheduled turn so far took 7 minutes, and a turn starts about
  # 5 seconds after its slot.
  holdMinutes = 25;

  minuteOfDay = at:
    let hm = map lib.toIntBase10 (lib.splitString ":" at);
    in builtins.elemAt hm 0 * 60 + builtins.elemAt hm 1;
  wakeMinute = slot: minuteOfDay slot.at - leadMinutes;
  wakeAt = slot: { Hour = wakeMinute slot / 60; Minute = lib.mod (wakeMinute slot) 60; };
  weekdays = slot: slot.weekdays or [ 0 1 2 3 4 5 6 ];

  script = pkgs.writeShellScript "wake-schedule" (builtins.readFile ../scripts/wake-schedule);
in
{
  assertions = map (slot: {
    assertion = wakeMinute slot >= 0;
    message = "nix/wake-schedule.nix: the wake for ${slot.at} falls on the previous day, and its launchd calendar entry would need the previous weekday; that is not handled.";
  }) slots;

  launchd.daemons.wake-schedule = {
    command = "${script} run";
    # macOS's own date: the script uses BSD flags (-j -f, -v, -r).
    path = [ "/usr/bin" "/bin" "/usr/sbin" "/sbin" ];
    environment = {
      WAKE_SLOTS = lib.concatMapStringsSep " "
        (slot: "${slot.at}/${lib.concatMapStrings toString (weekdays slot)}") slots;
      WAKE_LEAD_MIN = toString leadMinutes;
      WAKE_HOLD_MIN = toString holdMinutes;
    };
    serviceConfig = {
      Label = "com.${username}.wake-schedule";
      # At boot and at every activation: requeue the wakes, and carry on or
      # end a hold that a reload interrupted.
      RunAtLoad = true;
      # At each wake time. launchd runs a calendar job missed during sleep as
      # soon as the Mac wakes, so the wake itself starts the hold.
      StartCalendarInterval = lib.unique (lib.concatMap
        (slot: if slot ? weekdays then map (d: wakeAt slot // { Weekday = d; }) slot.weekdays else [ (wakeAt slot) ])
        slots);
      StandardOutPath = "/var/log/wake-schedule.log";
      StandardErrorPath = "/var/log/wake-schedule.log";
    };
  };
}
