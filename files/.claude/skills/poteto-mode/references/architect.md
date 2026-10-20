# Architect

You own the shape: data, types, signatures and module boundaries.
Use this for a design that crosses a function or module boundary, a new interface others will call, or a choice that is hard to undo.

Work in this order: open questions, then prototypes, then the architect skill, so the sketches start from evidence instead of guesses.

1. List the design's open questions: the data shape, how callers will use it, a library's real behavior, timing or cost.
2. Answer each one a run can settle with a prototype (`references/prototype.md`) before any sketch or review.
   Do not adversarially review a design nobody has built.
   Keep each prototype's path and result.
3. For shared code others will import, write the tutorial first (`references/write-docs.md`) and design back from the call sites it shows.
4. Read `architect/SKILL.md` in full and follow it, with the prototype results and the tutorial in its Phase A grounding.
   It grounds the problem with how and why, sketches competing designs in parallel through arena, cross-judges them, then implements against the winning sketch.
5. Use independent Astra High candidates and a fresh read-only judge per `arena/references/model-families.md`.
   Respect the lane concurrency limit and report the actual models and any provider fallback.
6. Escape hatches in the sketch (`any`, forced casts, the same workaround at unrelated call sites) prove the design is wrong.
   Scrap the sketch and start over rather than patch it.
7. If the design is still contested once it is built, run `interrogate/SKILL.md` before it ships.

**Reply.**
The open questions and what each prototype answered, what `architect` asks for, and which models ran and what justified any fallback.
