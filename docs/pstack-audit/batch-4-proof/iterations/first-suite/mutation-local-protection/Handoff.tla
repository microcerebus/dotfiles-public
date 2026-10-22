------------------------------ MODULE Handoff ------------------------------
EXTENDS Naturals

\* Manual abstraction of scripts/dotfiles-autoupdate at da07c62.
\* Each action has a source-map entry in source-map.md.
\* One sync, one apply, one optional human rebuild, one optional external fetch.
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
              syncDir : {FALSE}, syncPid : {FALSE}, switching : {FALSE}]
    /\ s = [pc |-> "acquire", fetched |-> "None", temp |-> "None",
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
AdvanceAllowed == TRUE

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

SyncCheck ==
    /\ s.pc = "checkSwitch"
    /\ s' = [s EXCEPT !.pc = IF g.switching \/ h = "running"
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

SyncMain ==
    /\ s.pc = "main"
    \* Only this checkout's fast-forward is relevant; branch/errors are scoped.
    /\ g' = [g EXCEPT !.head = IF Ancestor(g.head, s.fetched) /\ ~g.dirty
                              THEN s.fetched ELSE g.head]
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
    /\ a' = [a EXCEPT !.pc = IF h = "running" THEN "done" ELSE "checkSync"]
    /\ UNCHANGED <<g, s, h, refMoved>>

ApplyCheckSync ==
    /\ a.pc = "checkSync"
    /\ a' = [a EXCEPT !.pc = IF g.syncPid THEN "done" ELSE "readTarget"]
    /\ UNCHANGED <<g, s, h, refMoved>>

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
                             THEN "done" ELSE "checkNewer"]
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
    /\ a' = [a EXCEPT !.pc = IF g.hm THEN "done" ELSE "retry"]
    /\ UNCHANGED <<g, s, h, refMoved>>

ApplyAdvance ==
    /\ a.pc = "checkAdvance"
    /\ a' = [a EXCEPT !.pc = IF AdvanceAllowed THEN "retry" ELSE "done"]
    /\ UNCHANGED <<g, s, h, refMoved>>

ApplyRetry ==
    /\ a.pc = "retry"
    \* Retry cooldown can stop this attempt, or allow it.
    /\ a' \in {[a EXCEPT !.pc = "mark"], [a EXCEPT !.pc = "done"]}
    /\ UNCHANGED <<g, s, h, refMoved>>

ApplyMark ==
    /\ a.pc = "mark"
    /\ g' = [g EXCEPT !.switching = TRUE]
    /\ a' = [a EXCEPT !.pc = "recheck"]
    /\ UNCHANGED <<s, h, refMoved>>

ApplyRecheck ==
    /\ a.pc = "recheck"
    /\ a' = [a EXCEPT !.pc = IF g.syncPid THEN "release" ELSE "invoke"]
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
    /\ a' = [a EXCEPT !.pc = "done"]
    /\ UNCHANGED <<s, h, refMoved>>

HumanStart ==
    /\ h = "idle"
    /\ h' = "running"
    /\ UNCHANGED <<g, s, a, refMoved>>

HumanComplete ==
    /\ h = "running"
    /\ \E localRevision \in Protected :
         g' = [g EXCEPT !.installed = localRevision, !.hm = TRUE,
                       !.head = IF localRevision = "L" THEN "L" ELSE "B",
                       !.dirty = (localRevision = "Dirty")]
    /\ h' = "done"
    /\ UNCHANGED <<s, a, refMoved>>

ExternalFetch ==
    /\ ~refMoved
    /\ g.origin = "B"
    /\ g' = [g EXCEPT !.origin = "C"]
    /\ refMoved' = TRUE
    /\ UNCHANGED <<s, a, h>>

Next ==
    \/ SyncAcquire \/ SyncPid \/ SyncCheck \/ SyncFetch \/ SyncReadRef
    \/ SyncMain \/ SyncWriteTemp \/ SyncRename \/ SyncRenameFail \/ SyncRelease
    \/ ApplyCheckHuman \/ ApplyCheckSync \/ ApplyReadTarget \/ ApplyReadRunning
    \/ ApplyValidate \/ ApplyCheckNewer \/ ApplyCheckOrigin \/ ApplyChoose
    \/ ApplySame \/ ApplyHM \/ ApplyAdvance \/ ApplyRetry \/ ApplyMark
    \/ ApplyRecheck \/ ApplyInvoke \/ ApplyComplete \/ ApplyFail \/ ApplyRelease
    \/ HumanStart \/ HumanComplete \/ ExternalFetch

Spec == Init /\ [][Next]_vars
\* Diagnostic only: distinguish the guard mutation from the baseline human race.
NoHumanSpec == Init /\ [][Next /\ UNCHANGED h]_vars

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
=============================================================================
