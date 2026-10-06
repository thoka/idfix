---
kind: task
from: idfix
date: 2026-10-06
---

Severin keeps only the exit code of `mise run test`, not its output, so nobody can name a failing test. Make the tick of Severin write the test output to a log file and put the path of that file into the event and into the notice to the session.

Evidence: `~/.local/state/severin/events.jsonl`, project idfix, plan 9b743d0. The ticks at 11:22, 11:27, 11:35, and 11:42 on 2026-10-06 have `tests.code` 0, and the tick at 11:47 has `tests.code` 1 (event id 59). It notified idfix "the tests fail". A run of `mise run test` in idfix directly after gave 1286 pass and 0 fail. So the failure is flaky. A likely cause is the known timeout of integration tests under load (idfix plan, section "Later"), but without the output this stays a guess.
