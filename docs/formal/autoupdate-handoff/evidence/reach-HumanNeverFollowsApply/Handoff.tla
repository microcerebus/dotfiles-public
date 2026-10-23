------------------------------ MODULE Handoff ------------------------------
EXTENDS Naturals

\* Manual abstraction of scripts/dotfiles-autoupdate with the switch-lock fix.
\* Derived from docs/pstack-audit/batch-4-proof/Handoff.tla (the unfixed code).
\* Each action has a source-map entry in source-map.md.
\* One sync, one apply, one optional human rebuild, one optional external fetch.
\* HumanLocks: the human switches through `rebuild`, which holds the switch
\* lock; FALSE models a darwin-rebuild run outside it (the old alias).
\* ApplyLocks: apply decides and switches under the switch lock.
\* Recheck: apply's last pgrep and running-revision check before its switch.
\* The fixed source is all three TRUE; the runner turns each off in turn.
CONSTANTS HumanLocks, ApplyLocks, Recheck
\* A -> B -> C is pushed history; B -> L is a local, unpushed branch.
Commits == {"A", "B", "C", "L"}
Protected == {"L", "Dirty"}
Ancestor(x, y) ==
    x = y \/ (x = "A" /\ y \in {"B", "C", "L"})
           \/ (x = "B" /\ y \in {"C", "L"})

VARIABLES g, s, a, h, refMoved
vars == <<g, s, a, h, refMoved>>

Init ==
    /\ g \in [origin : {"B", "C"},
              handoff : {"None", "Bad", "A", "B"},
              installed : Commits \cup {"Dirty", "Unknown"},
              head : {"A", "L"}, dirty : BOOLEAN,
              hm : BOOLEAN,
              syncDir : {FALSE}, syncPid : {FALSE}, switching : {FALSE},
              switchLock : {"none"}]
    /\ s = [pc |-> "acquire", fetched |-> "None", temp |-> "None",
            marker |-> FALSE, mainHead |-> "None",
            published |-> FALSE, sent |-> "None"]
    /\ a = [pc |-> "checkHuman", target |-> "None", sampled |-> "None",
            want |-> "None", newer |-> FALSE, originRead |-> "None",
            invoked |-> FALSE, request |-> "None", applied |-> FALSE,
            before |-> "None", built |-> "None"]
    /\ h = "idle"
    /\ refMoved = FALSE

\* Mutation sites: these expressions are MANUALLY reconciled with source edits.
PublishValue == s.fetched
RequestedRevision == a.want
AdvanceAllowed == Ancestor(a.sampled, a.want)

\* pgrep -f darwin-rebuild: a running switch, or a rebuild waiting in lockf,
\* whose command line names darwin-rebuild.
HumanVisible == h \in {"waiting", "running"}

SyncAcquire ==
    /\ s.pc = "acquire"
    /\ g' = [g EXCEPT !.syncDir = TRUE]
    /\ s' = [s EXCEPT !.pc = "pid"]
    /\ UNCHANGED <<a, h, refMoved>>

SyncPid ==
    /\ s.pc = "pid"
    /\ g' = [g EXCEPT !.syncPid = TRUE]
    /\ s' = [s EXCEPT !.pc = "checkSwitch"]
    /\ UNCHANGED <<a, h, refMoved>>

SyncCheckHuman ==
    /\ s.pc = "checkSwitch"
    /\ s' = [s EXCEPT !.pc = IF HumanVisible THEN "release" ELSE "readDaemon"]
    /\ UNCHANGED <<g, a, h, refMoved>>

SyncReadDaemon ==
    /\ s.pc = "readDaemon"
    /\ s' = [s EXCEPT !.marker = g.switching, !.pc = "checkDaemon"]
    /\ UNCHANGED <<g, a, h, refMoved>>

SyncCheckDaemon ==
    /\ s.pc = "checkDaemon"
    /\ s' = [s EXCEPT !.pc = IF s.marker /\ a.pc # "done"
                             THEN "release" ELSE "fetch"]
    /\ UNCHANGED <<g, a, h, refMoved>>

SyncFetch ==
    /\ s.pc = "fetch"
    \* Successful fetch, or offline/fetch failure with no new handoff.
    /\ s' \in {[s EXCEPT !.pc = "readRef"], [s EXCEPT !.pc = "release"]}
    /\ UNCHANGED <<g, a, h, refMoved>>

SyncReadRef ==
    /\ s.pc = "readRef"
    /\ s' = [s EXCEPT !.fetched = g.origin, !.pc = "main"]
    /\ UNCHANGED <<g, a, h, refMoved>>

SyncReadHead ==
    /\ s.pc = "main"
    /\ s' = [s EXCEPT !.mainHead = g.head, !.pc = "mainCheck"]
    /\ UNCHANGED <<g, a, h, refMoved>>

SyncCheckMain ==
    /\ s.pc = "mainCheck"
    /\ s' = [s EXCEPT !.pc = IF s.mainHead # s.fetched
                                /\ Ancestor(s.mainHead, s.fetched)
                             THEN "merge" ELSE "writeTemp"]
    /\ UNCHANGED <<g, a, h, refMoved>>

SyncMerge ==
    /\ s.pc = "merge"
    \* Git checks the current HEAD again at merge time, not the shell's sample.
    \* Failure is possible; dirty nonconflicting changes may also fast-forward.
    /\ g' \in IF Ancestor(g.head, s.fetched)
              THEN {g, [g EXCEPT !.head = s.fetched]} ELSE {g}
    /\ s' = [s EXCEPT !.pc = "writeTemp"]
    /\ UNCHANGED <<a, h, refMoved>>

SyncWriteTemp ==
    /\ s.pc = "writeTemp"
    /\ s' \in {[s EXCEPT !.temp = PublishValue, !.pc = "rename"],
               [s EXCEPT !.pc = "release"]}
    /\ UNCHANGED <<g, a, h, refMoved>>

SyncRename ==
    /\ s.pc = "rename"
    /\ g' = [g EXCEPT !.handoff = s.temp]
    /\ s' = [s EXCEPT !.pc = "release", !.published = TRUE, !.sent = s.temp]
    /\ UNCHANGED <<a, h, refMoved>>

SyncRenameFail ==
    /\ s.pc = "rename"
    /\ s' = [s EXCEPT !.pc = "release"]
    /\ UNCHANGED <<g, a, h, refMoved>>

SyncRelease ==
    /\ s.pc = "release"
    /\ g' = [g EXCEPT !.syncDir = FALSE, !.syncPid = FALSE]
    /\ s' = [s EXCEPT !.pc = "done"]
    /\ UNCHANGED <<a, h, refMoved>>

ApplyCheckHuman ==
    /\ a.pc = "checkHuman"
    /\ a' = [a EXCEPT !.pc = IF HumanVisible THEN "done" ELSE "checkSync"]
    /\ UNCHANGED <<g, s, h, refMoved>>

ApplyCheckSync ==
    /\ a.pc = "checkSync"
    /\ a' = [a EXCEPT !.pc = IF g.syncPid THEN "done" ELSE "lock"]
    /\ UNCHANGED <<g, s, h, refMoved>>

\* lockf -t 0: take the free lock, or stop until the next tick.
ApplyLock ==
    /\ a.pc = "lock"
    /\ IF ~ApplyLocks
       THEN /\ a' = [a EXCEPT !.pc = "readTarget"]
            /\ UNCHANGED g
       ELSE IF g.switchLock = "none"
       THEN /\ g' = [g EXCEPT !.switchLock = "apply"]
            /\ a' = [a EXCEPT !.pc = "readTarget"]
       ELSE /\ a' = [a EXCEPT !.pc = "done"]
            /\ UNCHANGED g
    /\ UNCHANGED <<s, h, refMoved>>

ApplyReadTarget ==
    /\ a.pc = "readTarget"
    /\ a' = [a EXCEPT !.target = g.handoff, !.pc = "readRunning"]
    /\ UNCHANGED <<g, s, h, refMoved>>

ApplyReadRunning ==
    /\ a.pc = "readRunning"
    /\ a' = [a EXCEPT !.sampled = g.installed, !.pc = "validate"]
    /\ UNCHANGED <<g, s, h, refMoved>>

ApplyValidate ==
    /\ a.pc = "validate"
    /\ a' = [a EXCEPT !.want = a.target,
                      !.pc = IF a.target \notin Commits
                                \/ a.sampled \in {"Unknown", "Dirty"}
                             THEN "unlock" ELSE "checkNewer"]
    /\ UNCHANGED <<g, s, h, refMoved>>

ApplyCheckNewer ==
    /\ a.pc = "checkNewer"
    /\ a' = [a EXCEPT !.pc = IF a.sampled # a.target
                                /\ Ancestor(a.target, a.sampled)
                             THEN "checkOrigin" ELSE "same"]
    /\ UNCHANGED <<g, s, h, refMoved>>

ApplyCheckOrigin ==
    /\ a.pc = "checkOrigin"
    /\ a' = [a EXCEPT !.originRead = g.origin,
                      !.newer = Ancestor(a.sampled, g.origin),
                      !.pc = "choose"]
    /\ UNCHANGED <<g, s, h, refMoved>>

ApplyChoose ==
    /\ a.pc = "choose"
    /\ a' = [a EXCEPT !.want = IF a.newer THEN a.sampled ELSE a.target,
                      !.pc = "same"]
    /\ UNCHANGED <<g, s, h, refMoved>>

ApplySame ==
    /\ a.pc = "same"
    /\ a' = [a EXCEPT !.pc = IF a.sampled = a.want THEN "checkHM"
                             ELSE "checkAdvance"]
    /\ UNCHANGED <<g, s, h, refMoved>>

ApplyHM ==
    /\ a.pc = "checkHM"
    /\ a' = [a EXCEPT !.pc = IF g.hm THEN "unlock" ELSE "retry"]
    /\ UNCHANGED <<g, s, h, refMoved>>

ApplyAdvance ==
    /\ a.pc = "checkAdvance"
    /\ a' = [a EXCEPT !.pc = IF AdvanceAllowed THEN "retry" ELSE "unlock"]
    /\ UNCHANGED <<g, s, h, refMoved>>

ApplyRetry ==
    /\ a.pc = "retry"
    \* Retry cooldown can stop this attempt, or allow it.
    /\ a' \in {[a EXCEPT !.pc = "mark"], [a EXCEPT !.pc = "unlock"]}
    /\ UNCHANGED <<g, s, h, refMoved>>

ApplyMark ==
    /\ a.pc = "mark"
    /\ g' = [g EXCEPT !.switching = TRUE]
    /\ a' = [a EXCEPT !.pc = "recheck"]
    /\ UNCHANGED <<s, h, refMoved>>

ApplyRecheck ==
    /\ a.pc = "recheck"
    /\ a' = [a EXCEPT !.pc = IF g.syncPid THEN "release"
                             ELSE IF Recheck THEN "recheckHuman" ELSE "invoke"]
    /\ UNCHANGED <<g, s, h, refMoved>>

ApplyRecheckHuman ==
    /\ a.pc = "recheckHuman"
    /\ a' = [a EXCEPT !.pc = IF HumanVisible THEN "release" ELSE "recheckRunning"]
    /\ UNCHANGED <<g, s, h, refMoved>>

ApplyRecheckRunning ==
    /\ a.pc = "recheckRunning"
    /\ a' = [a EXCEPT !.pc = IF g.installed # a.sampled THEN "release" ELSE "invoke"]
    /\ UNCHANGED <<g, s, h, refMoved>>

ApplyInvoke ==
    /\ a.pc = "invoke"
    /\ a' = [a EXCEPT !.request = RequestedRevision, !.invoked = TRUE,
                      !.pc = "complete"]
    /\ UNCHANGED <<g, s, h, refMoved>>

ApplyComplete ==
    /\ a.pc = "complete"
    \* Successful activation is an atomic system-revision change.
    /\ a' = [a EXCEPT !.before = g.installed, !.built = a.request,
                      !.applied = TRUE, !.pc = "release"]
    /\ g' = [g EXCEPT !.installed = a.request, !.hm = TRUE]
    /\ UNCHANGED <<s, h, refMoved>>

ApplyFail ==
    /\ a.pc = "complete"
    \* A failure before activation changes no system revision.
    /\ a' = [a EXCEPT !.pc = "release"]
    /\ UNCHANGED <<g, s, h, refMoved>>

ApplyRelease ==
    /\ a.pc = "release"
    /\ g' = [g EXCEPT !.switching = FALSE]
    /\ a' = [a EXCEPT !.pc = "unlock"]
    /\ UNCHANGED <<s, h, refMoved>>

\* lockf releases the lock when apply-locked exits, after its EXIT trap.
ApplyUnlock ==
    /\ a.pc = "unlock"
    /\ g' = [g EXCEPT !.switchLock = IF ApplyLocks THEN "none" ELSE g.switchLock]
    /\ a' = [a EXCEPT !.pc = "done"]
    /\ UNCHANGED <<s, h, refMoved>>

\* `rebuild` waits in lockf; a darwin-rebuild outside it starts at once.
HumanRequest ==
    /\ h = "idle"
    /\ h' = IF HumanLocks THEN "waiting" ELSE "running"
    /\ UNCHANGED <<g, s, a, refMoved>>

HumanStart ==
    /\ h = "waiting"
    /\ g.switchLock = "none"
    /\ g' = [g EXCEPT !.switchLock = "human"]
    /\ h' = "running"
    /\ UNCHANGED <<s, a, refMoved>>

\* rebuild gives up after its wait, having switched nothing.
HumanGiveUp ==
    /\ h = "waiting"
    /\ h' = "done"
    /\ UNCHANGED <<g, s, a, refMoved>>

HumanComplete ==
    /\ h = "running"
    /\ \E localRevision \in Protected :
         g' = [g EXCEPT !.installed = localRevision, !.hm = TRUE,
                       !.head = IF localRevision = "L" THEN "L" ELSE "B",
                       !.dirty = (localRevision = "Dirty"),
                       !.switchLock = IF HumanLocks THEN "none" ELSE g.switchLock]
    /\ h' = "done"
    /\ UNCHANGED <<s, a, refMoved>>

ExternalFetch ==
    /\ ~refMoved
    /\ g.origin = "B"
    /\ g' = [g EXCEPT !.origin = "C"]
    /\ refMoved' = TRUE
    /\ UNCHANGED <<s, a, h>>

Next ==
    \/ SyncAcquire \/ SyncPid \/ SyncCheckHuman \/ SyncReadDaemon \/ SyncCheckDaemon
    \/ SyncFetch \/ SyncReadRef \/ SyncReadHead \/ SyncCheckMain \/ SyncMerge
    \/ SyncWriteTemp \/ SyncRename \/ SyncRenameFail \/ SyncRelease
    \/ ApplyCheckHuman \/ ApplyCheckSync \/ ApplyLock \/ ApplyReadTarget
    \/ ApplyReadRunning \/ ApplyValidate \/ ApplyCheckNewer \/ ApplyCheckOrigin
    \/ ApplyChoose \/ ApplySame \/ ApplyHM \/ ApplyAdvance \/ ApplyRetry
    \/ ApplyMark \/ ApplyRecheck \/ ApplyRecheckHuman \/ ApplyRecheckRunning
    \/ ApplyInvoke \/ ApplyComplete \/ ApplyFail \/ ApplyRelease \/ ApplyUnlock
    \/ HumanRequest \/ HumanStart \/ HumanGiveUp \/ HumanComplete \/ ExternalFetch

Spec == Init /\ [][Next]_vars
\* Diagnostic only: distinguish the guard mutation from the baseline human race.
NoHumanSpec == Init /\ [][Next /\ UNCHANGED h]_vars
\* Diagnostic witness: the human switch starts and finishes after all apply
\* checks, before apply invokes darwin-rebuild. With HumanLocks it cannot.
PreInvokeRaceSpec ==
    Init /\ [][Next
        /\ ((h' # h) => a.pc = "invoke")
        /\ ((~a.invoked /\ a'.invoked) => h = "done")]_vars

HandoffIsFetched == ~s.published \/ s.sent = s.fetched
ExactSelectedRevision ==
    ~a.invoked \/
        /\ a.request = a.want
        /\ (a.want = a.target \/
            (a.want = a.sampled /\ a.newer
                /\ Ancestor(a.target, a.sampled)
                /\ Ancestor(a.sampled, a.originRead)))
ProtectLocalRebuild ==
    ~a.applied \/ a.before \notin Protected \/ a.built = a.before
\* The lock's own promise: apply never switches while a human switch runs.
NoOverlappingSwitch == ~(a.pc = "complete" /\ h = "running")

\* Reachability probes, each expected to be violated, so the passes above are
\* not vacuous: apply switches, a rebuild waits through apply's switch, and
\* a human switch lands after apply's.
ApplyNeverSwitches == ~a.applied
RebuildNeverWaitsOnSwitch == ~(h = "waiting" /\ a.pc = "complete")
HumanNeverFollowsApply == ~(a.applied /\ h = "done" /\ g.installed \in Protected)
=============================================================================
