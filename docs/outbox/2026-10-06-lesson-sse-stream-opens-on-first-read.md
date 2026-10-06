---
kind: lesson
from: idfix
date: 2026-10-06
---

# An SSE subscription that an async generator gives opens its connection only on the first `next()`, so start the read before the first state check.

In `@opencode-ai/sdk` 1.18.32, `event.subscribe()` returns a stream built by an async generator. The `fetch` of `/event` runs only when the code calls `next()` the first time. Code that subscribes, then checks the state, then reads the stream, loses each event between the subscribe and the first read.
In idfix, `watch` lost tool events at its start, and a test timed out in 1 of 5 runs. A real user could lose a permission request in the same window.
Call `next()` right after the subscribe, wait for the first event (the opencode server sends `server.connected`), with a short limit, and only then check the state. Keep the pending item for the read loop.
Source: idfix commit 21c0db2 (`src/watch.ts`), 2026-10-06.

Related: opencode-sdk-sse-abort-unhandled.md.
