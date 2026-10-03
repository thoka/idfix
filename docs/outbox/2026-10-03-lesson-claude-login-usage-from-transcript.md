---
kind: lesson
from: opencode-subagents
date: 2026-10-03
---

# Read the usage of a claude.ai login session from its transcript, not through a proxy.

A proxy as `ANTHROPIC_BASE_URL` in front of a session with a claude.ai login turns off Remote Control and prints a warning. The terms do not name a local proxy that forwards the OAuth token, so it is a gray zone. A dead proxy also stops every such session at once, the supervisor included.
A subscription request has no cost in USD, and the transcript `~/.claude/projects/<folder>/<session>.jsonl` has the same token counts. `claude agents --json` lists every session of the machine with its `sessionId`.
Use a proxy only for API-key endpoints that report a real cost, for example OpenRouter.

Source: opencode-subagents/docs/design/driver-layer.md, section 3, and docs/research/driver-interface.md, section 6.3.
