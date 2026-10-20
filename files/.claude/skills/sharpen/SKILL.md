---
name: sharpen
description: "Rewrite a prompt with the expert approach, primary sources, specific methods and an independent check. Improve its depth without expanding its scope. Use for /sharpen."
disable-model-invocation: true
---

# Sharpen

Return a better prompt; do not execute the task inside it.
Before rewriting, state:

1. What a top professional would do that the prompt has missed.
2. The primary material they would start from.
3. The specific methods and tools they would use.
4. What independent evidence would show the result is right.

Then rewrite the prompt to include those improvements without expanding its scope.
Preserve the user's constraints and leave their unresolved choices open.
