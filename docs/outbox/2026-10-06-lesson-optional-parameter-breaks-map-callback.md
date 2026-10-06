---
kind: lesson
from: idfix
date: 2026-10-06
---

# An optional parameter breaks each call site that passes the function to `map` directly.

`Array.prototype.map` calls its callback with three arguments: the element, the index, and the array. If you add an optional second parameter to a function, a call site like `rows.map(toWatchRow)` passes the index as that parameter. TypeScript does not always catch it, for example when the parameter type accepts a number or the call goes through `any`.

When you add an optional parameter, search for each place that passes the function by name (`.map(fn)`, `.forEach(fn)`, `.then(fn)`), and change it to an arrow: `rows.map((row) => toWatchRow(row))`. Prefer a deps object over a positional optional parameter for an injected function.

Source: idfix step 36 (ed0af5c), `toWatchRow` in `src/watch/run.ts` and `src/status.ts`.
