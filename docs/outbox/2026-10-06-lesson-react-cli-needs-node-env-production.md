---
kind: lesson
from: idfix
date: 2026-10-06
---

# A long-running React or Ink terminal app must set NODE_ENV=production, or it leaks memory.

If a CLI starts bun or node without `NODE_ENV`, `react` loads its development build.
The development build keeps data of every render.
A view that redraws once per second then grows without limit: `idfx top` grew about 1.5 MB per minute, 7 GB after 2 days.
The leak is outside the JS heap of bun, so a heap snapshot looks flat. Measure the RSS of the process instead.
It is not a runtime bug: the same Ink probe leaked under bun 1.4.2 and under Node 24.
Fix: set `process.env.NODE_ENV ??= "production"` before the first import of React or Ink, for example before a dynamic import of the view.
Add a test that spawns a child process without `NODE_ENV` and makes sure that `react.production.js` is in `require.cache`.

Source: idfix step 29d, commit 48cc99c (2026-10-06).
