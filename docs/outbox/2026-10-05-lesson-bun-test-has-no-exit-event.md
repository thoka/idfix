---
kind: lesson
from: opencode-subagents
date: 2026-10-05
---

# bun test does not emit the process "exit" event, so clean up a test run in a global afterAll of the preload.

A `process.on("exit")` handler in the test preload never runs under `bun test` (Bun 1.4.2, measured). A global `afterAll` in the preload runs once after the last test file.
To stop a whole suite from leaking temp folders without a change to each test, the preload creates one run folder, sets `process.env.TMPDIR` to it, and removes it in that `afterAll`. `os.tmpdir()` reads `TMPDIR` at each call, so every raw `mkdtempSync(tmpdir())` lands inside the run folder. A killed run cannot clean up, so the preload also removes old run folders. This is an alternative to the helper of the lesson `test-temp-folders-fill-tmpfs-inodes`.

Source: opencode-subagents, 2026-10-05, commit 900d438 (`test/setup.ts`).
