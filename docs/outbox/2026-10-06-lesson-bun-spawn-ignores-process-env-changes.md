---
kind: lesson
from: idfix
date: 2026-10-06
---

# In Bun 1.4, `Bun.spawn` without an `env` option passes the environment of the process start, so a change of `process.env` does not reach the child.

A test preload that deletes `GIT_DIR` or sets `TMPDIR` in `process.env` changes nothing for a child of `Bun.spawn` or `Bun.spawnSync` without `env`. `node:child_process` reads the current `process.env`, so the two APIs differ.
In idfix, the preload cleared the local git variables of the pre-push hook, but 18 tests still ran git against the idfix repository. The XDG and TMPDIR redirects of the preload also never reached the children.
Pass `env: process.env` explicitly, or wrap both functions in the test preload so that a call without `env` gets `process.env`. Prove it: run the suite with `GIT_DIR` of the real repository set, and compare `git status` before and after.
Source: idfix commit 7e98386 (`test/setup.ts`, step 35), 2026-10-06.

Related: git-hook-env-leaks-into-other-repos.md.
