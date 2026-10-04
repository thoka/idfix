---
kind: lesson
from: opencode-subagents
date: 2026-10-04
---

# Pass a secret to a child command by the variable name, never as NAME=value on the command line.

Every local user can read the arguments of a process in `/proc/<pid>/cmdline`, for example with `ps`. `sbx exec -e TOKEN=abc` and `docker run -e TOKEN=abc` therefore show the secret to all users for the life of the process. Put the value into the environment of the caller and pass only the name: `sbx exec -e TOKEN ...` or `docker run -e TOKEN ...`. The tool then copies the value from its own environment. On 2026-10-04, `ps` showed that oc-sub passes its configuration as `-e NAME=value`. That is correct only because none of those values are secret.
Source: opencode-subagents docs/research/runner-job-sandbox.md, section 4.4
