---
name: ketchup
description: "Catch the user up on what changed in this chat, in plain words and useful visuals. List every waiting decision with enough context to decide from the reply alone. Use for /ketchup."
disable-model-invocation: true
---

# Ketchup

Explain what changed since the user's last message before `/ketchup`, then make every waiting decision understandable from the reply alone.
Notifications and subagent results are not user messages.
Assume the user remembers their last message and nothing after it.
Apply unslop.
Use names the user knows and plain words such as "the tests pass".
Leave out file paths, commands, build numbers and test counts unless needed to act.
Never show raw SHAs, thread IDs or other identifiers unless the user asks.

## Gather what changed

Keep this turn read-only.
Use existing facts and artifacts; do not change code, start an app or job, or post anything.
Collect your work, subagent reports and messages since that user message.
Check current PR and check state with `gh-axi`, and delegated work with T3 `task_status` or `t3_thread_read`.
Verify every number you show against its source and explain any correction.

An action item is a call only the user can make, such as a product choice, approval, irreversible action or access you lack.
Include unresolved items raised before their last message.
First check the lane's `authorizations.md` and thread history; omit anything already approved or finished.
Work you can do yourself is not an action item.
Never invent a decision to fill the reply.
For an unasked, unnecessary irreversible step awaiting approval, use only one line and no visual.

For each item, collect its link when available, what it changes for users, evidence, risk and your recommendation.
Write "unknown" for a needed fact you could not establish.
Do not invent links or evidence.

## Write the reply

Open with a **Needs the owner** list containing every action item, or "Needs the owner: nothing."
If nothing happened and nothing waits on the user, stop there.
For one item, state the decision, your recommendation, user impact, evidence and risk together.
When several items share a decision, state that decision and recommendation once, then list every item separately, riskiest first.
Include each item's name and link when known, impact, evidence and risk, even when the risk is low.
Name a different recommendation only where it differs from the shared one.
Include prerequisites and irreversible consequences in the recommendation.
Say what waiting costs only when it means more than delay.
For choices, give each considered option's gain and cost, including the current state when relevant.

Keep each unit to at most five plain lines.
Spend words on decisions and keep the account of what happened under 100 words, excluding visuals.
Do not cut, collapse or replace action items with a count or link to meet a word limit.
The reply may grow with the number of decisions.
Give each fact once.

After the action list, embed existing screenshots or videos and diagrams that explain a change.
Summarize each requested outcome that the action list has not already covered: done, running, failed or unverified.
Name bugs found and fixed on the way.
An item awaiting user action is not done.
For a visible change without captured evidence, say "No screenshot yet" and describe what changed on screen.
End with any work you can still do yourself, if there is any.

## Visuals

Use pictures to explain connections, behavior, dependencies or choices.
Do not draw status lists, action lists or unconnected boxes.
A Markdown table is not a picture.
Keep diagrams small, with at most six boxes and eight words per box.
Embed actual screenshots and videos inline.
Never invent numbers or draw a screen you did not capture.
Link only artifacts that exist.

In T3 Code, check a self-contained HTML page with `html_preview` and publish it with `html_render`.
The page appears above the reply; put its Needs the owner list first and do not repeat its content in chat.
Use Mermaid for small flow diagrams and `html_render` for charts when they help explain the work.
