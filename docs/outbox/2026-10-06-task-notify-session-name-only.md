---
kind: task
from: idfix
date: 2026-10-06
---

# `notify-session` needs a form without a session id

`idfx watch --all` wakes the supervisor by name. `notify-session` requires the positional `session_id` before the text, so idfix calls `notify-session --name supervisor -- none "<text>"`. The id `none` matches no session, and the `--name` fallback decides.

Change `~/dv/meta/dv/bin/notify-session` so that `--name NAME` (or `--project`) works without a session id, for example `notify-session --name supervisor "<text>"`. Keep the old form working. After the change, idfix drops the `none` placeholder in `src/watch/wake.ts`.

Evidence: `notify-session --help` on 2026-10-06, and idfix commit a085731.
