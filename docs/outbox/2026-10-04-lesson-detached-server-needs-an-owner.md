---
kind: lesson
from: opencode-subagents
date: 2026-10-04
---

# A detached server that a tool starts needs an owner that stops it, or it runs forever.

`oc-sub up` started a detached `sbx exec ... opencode serve` for each project, and only `oc-sub down` stopped it. `run` used the server but never started or stopped it, so nobody owned its end. On 2026-10-04 five sandbox VMs had been idle for up to 1.8 days. Give each long-lived process an end condition when you start it: an idle timeout, a parent that it dies with, or a unit that a timer stops. Also start it on demand, so that an automatic stop costs only a short delay.
Source: opencode-subagents docs/PLAN.md, step 29
