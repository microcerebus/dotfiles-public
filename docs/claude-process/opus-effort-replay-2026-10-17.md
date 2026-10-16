# Opus 5.5 High versus Extra High replay

Measured on 17 October 2026 to inform the [ongoing effort guideline](../model-routing.md#opus-55-reasoning-effort).
Three frozen prompts were each run once at High and once at Extra High on fresh Opus 5.5 tasks, with Fast off.
Cases covered CI evidence triage, a historical diagnostic-privacy defect and its corrected producer.
A fresh Codex Sol High scorer received randomly ordered anonymous answers without effort labels, timing or usage.

## Results

Both settings scored **26/30** against the predeclared substantive rubric.
CI triage scored 9/10 at High and 9.5/10 at Extra High; the historical defect scored 8.5/10 at both; the corrected producer scored 8.5/10 at High and 8/10 at Extra High.
Both settings had factual errors or missing regression detail, so a tie is not a clean acceptance result.

High averaged **65.3 seconds** versus **97.7 seconds** at Extra High, using **33.2% less elapsed time** in aggregate.
High was faster in all three pairs: 33.7 versus 53.4 seconds, 59.8 versus 72.3 seconds, and 102.3 versus 167.5 seconds.
Timing uses T3 run start and completion timestamps rather than notification delay.
Pairs ran concurrently, so this is not a repeated single-thread speed benchmark.

High used **17,410 provider-reported output tokens** versus **27,918** at Extra High, or **37.6% fewer**.
Input, cache-read and cache-creation counters matched within every pair.
Usage was attributed through unique exact assistant-answer matches to native JSONL records and independently checked against those records.
No separate thinking-token counter was available.
The output-token difference is not a measurement of total cost or subscription allowance saved.

## Limits and follow-up

Three short offline pairs provide directional evidence only, not statistical equivalence or a result for long implementation, actual tool use, UI taste or all model versions.
Answer-length control was weak at both efforts; length was not part of the substantive score.
Both settings questioned the assumed correct answer for the corrected-producer case; follow-up on that scoring assumption is outside this comparison.
These research answers are not production review approvals and do not change review budgets or acceptance gates.

The full private report, frozen prompts, configurations, anonymous scores, timestamps and native usage attribution remain under `~/orchestrator/references/usage/opus-effort-replay-2026-10-17-*`.
Do not copy native transcripts or private provider state into this public-mirrorable repository.
Apply the role guideline at safe task boundaries and keep tracking real review findings and fix rounds before broadening it.
