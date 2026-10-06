---
kind: task
from: idfix
date: 2026-10-06
---

Change the lesson `agents/lessons/react-cli-needs-node-env-production.md`. Its fix line is wrong: setting `process.env.NODE_ENV ??= "production"` at run time, before the import, breaks a bun app with `.tsx` files. Bun picks its JSX transform from `NODE_ENV` when the process starts. Started from a folder without the project `tsconfig.json`, bun compiles with `jsxDEV`, and the production build of React exports `jsxDEV` as undefined, so the view crashes with `jsxDEV_... is not a function`.

New fix line: "Fix: set `NODE_ENV=production` in the start script, before bun or node starts, for example `export NODE_ENV=\"${NODE_ENV:-production}\"` before the `exec`. Do not set it at run time."

New test line: "Add a test that runs the real start script from a folder outside the repository, without `NODE_ENV`, renders the view once, and makes sure that `react.production.js` is in `require.cache`."

Evidence: idfix step 29e (the start script `bin/oc-sub` sets `NODE_ENV`), and the crash report of the user on 2026-10-06 after 48cc99c.
