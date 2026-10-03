# Error report: auto mode classifier timeouts in a Claude Code session on GLM

The user asked for this report on 2026-10-03 in the GLM session `2847278a` (name `opencode-subagents-09`). That session ended before it wrote the report. A Claude session wrote it afterwards from the transcript `~/.claude/projects/-home-toka-dv-opencode-subagents/2847278a-6b72-4702-b373-006362e6afeb.jsonl`.

## Summary

The session ran Claude Code 2.1.x through `claude-glm` with `--permission-mode auto`. All model slots pointed at `z-ai/glm-5.3-flash` on OpenRouter. Between 06:59 and 07:48 UTC, 17 tool calls failed because the auto mode classifier timed out. The classifier is the model call that judges whether a tool call is safe. Reads passed, because auto mode does not classify them. Writes failed: `git add && git commit`, and `SendMessage` to the session `Step 7c`.

No work was lost. The commits 8cbc097, 2b3bff1, and 8ba7410 landed after retries, and the message to `Step 7c` went out at about 07:48. But the session spent about 25 minutes in five retry timers of 2 to 10 minutes. The user then switched the session to manual mode and approved the calls by hand.

## Error text

```
z-ai/glm-5.3-flash is temporarily unavailable (timed out), so auto mode cannot determine the safety of Bash right now. Wait a moment and then try this action again. If it keeps failing, continue with other tasks that don't require this action and come back to it later.
```

The same text came for `SendMessage`.

## Timeline (UTC)

| Time | Event |
| --- | --- |
| 06:48 to 06:58 | All tool calls pass. |
| 06:59 to 07:20 | 8 classifier timeouts, between normal calls. The main model answers normally. |
| 07:20 to 07:48 | The session waits in Monitor timers of 2, 4, 2, 5, and 10 minutes, and retries the commit and the message. 5 more timeouts. |
| 07:48 | The message to `Step 7c` goes through. |
| 07:52 | The commit 8ba7410 and the push go through. The session hands off. |
| 07:54 | The user writes that they switched to manual mode, and asks for this report. |
| 08:04 | The last tool call, a read. The session then ends without the report. |

## Root cause

In a `claude-glm` session, the auto mode classifier runs on the same model as the session, `z-ai/glm-5.3-flash` through OpenRouter. Its answer often takes longer than the timeout of the classifier. The main model has a long timeout and so did not fail. This is a structural problem of `claude-glm`, not a one-time outage: auto mode depends on a fast classifier, and a reasoning model behind a gateway is not fast.

## Secondary problems

- The session handled the block with long sleep timers. The error text says to continue with other work, but the session had none left.
- The session did not tell the user early that auto mode was blocked. The user found it and approved the calls by hand.
- The session ended before the last task of the user. Its transcript shows no error at the end, so the cause of the end is unknown.

## Fix

The research for the fix is in `docs/research/glm-auto-mode-classifier.md`. The launcher `claude-glm` lives in meta, so the change goes to the supervisor through the outbox.
