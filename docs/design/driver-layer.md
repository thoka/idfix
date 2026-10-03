# Design: one driver layer for opencode and Claude Code

Step 25 of [PLAN.md](../PLAN.md), written on 2026-10-03. The inputs are [driver-interface.md](../research/driver-interface.md) with its claim check in section 6, [claude-in-sandbox.md](../research/claude-in-sandbox.md), and the decisions of the user in the plan. The text writes `idfx`, the new name of the CLI (step 24).

## 1. Goal

A driver is one agent CLI with one model endpoint. idfx gets three drivers, and the interface stays open for a fourth one, for example Codex:

| Driver | CLI | Endpoint | Where it runs |
| --- | --- | --- | --- |
| `opencode` | opencode 1.18.32 | OpenRouter, OpenAI shape | sandbox (exists) |
| `claude-glm` | Claude Code | OpenRouter, Anthropic shape (`/api/v1/messages`) | sandbox and host |
| `claude` | Claude Code | Anthropic, claude.ai login or API key | sandbox (step 23) and host |

All drivers share one run record, one cost table, and one `top`. They also share the commands `run`, `say`, `watch`, `log`, and `abort`. The table also shows the host sessions that the user starts by hand, and the supervisor.

## 2. Decisions

### 2.1 Extend the in-house proxy

idfx extends its own cost proxy and does not adopt LiteLLM or claude-code-router. LiteLLM brings a database and a UI for one user, and it needs extra configuration to handle the session blob of Claude Code. claude-code-router has no cost per session. The proxy already routes `/v1/...` to `https://openrouter.ai/api/v1/...`, so a Claude Code request to `/v1/messages` reaches the Anthropic shape of OpenRouter without a new route. Section 6.5 of the report makes sure that OpenRouter puts `cost` into the `usage` block of the last SSE event.

### 2.2 One cost source per driver

A run has exactly one cost source. This rule prevents double counting.

- `opencode` and `claude-glm`: the proxy log. OpenRouter reports the real cost in USD.
- `claude`: the transcript of the session (`~/.claude/projects/<folder>/<session>.jsonl`, or the `CLAUDE_CONFIG_DIR` of a sandbox). Each assistant message carries its token counts. idfx turns them into an API-equivalent cost with a price table, as ccusage does. A subscription session has no USD cost per request, so the proxy cannot know more than the transcript.

### 2.3 Session attribution in the proxy

Claude Code sends a JSON string in `metadata.user_id` with `session_id` since v2.1.78. The value is stable for the life of one session (report, section 6.1). The proxy reads the request body of `POST .../messages`, takes `session_id`, and logs only that field. It never logs `device_id`, `account_uuid`, or any other part of the body.

The driver also sets `ANTHROPIC_CUSTOM_HEADERS` with `x-idfx-project: <project>` and, for an idfx run, `x-idfx-run: <run id>`. The proxy logs these two headers next to the existing `X-Session-Id` and `x-parent-session-id`. An undocumented `X-Claude-Code-Session-Id` header exists in the wild. The spike of 25b looks whether 2.1.285 sends it. If it does, the proxy prefers it to the body field.

### 2.4 Proxy placement

- Sandbox: unchanged. The proxy runs next to `opencode serve` in the sandbox on port 4097. A `claude-glm` run in the sandbox points `ANTHROPIC_BASE_URL` at `http://127.0.0.1:4097`. The sbx credential proxy injects the OpenRouter key after the cost proxy, so the cost proxy never sees a key.
- Host: one proxy per user as a systemd user unit, `idfx-proxy.service`, on `127.0.0.1:4090`. It writes to `$XDG_STATE_HOME/idfx/proxy-host.log`. `idfx doctor` checks the unit, and `doctor --fix` installs and starts it. The host-mode proxy of `oc-sub up` (server port plus one) stays as it is, because host mode is legacy.
- The script `claude-glm` (meta) sets `ANTHROPIC_BASE_URL=http://127.0.0.1:4090` and the custom headers. If the proxy does not answer its health check, the script prints a warning and goes direct to OpenRouter. A dead proxy must not stop the work of the user. The cost of that session is then missing from the table, and the warning says so.

### 2.5 Key hygiene

The proxy keeps its current rule: it logs no header value except an allowlist, and it never logs a body. The allowlist is `X-Session-Id`, `x-parent-session-id`, `x-idfx-project`, and `x-idfx-run`. The one new body read (`metadata.user_id`) extracts `session_id` in memory and logs only that value. An error line carries the error message of the upstream, never the request. A test feeds requests with `Authorization`, `x-api-key`, and a full metadata blob, and makes sure that no log line contains them.

### 2.6 The driver interface

```ts
type DriverName = "opencode" | "claude-glm" | "claude";

interface Driver {
  name: DriverName;
  /** Start a run in a worktree and return its record. */
  start(spec: RunSpec): Promise<RunRecord>;
  say(run: RunRecord, text: string): Promise<void>;
  abort(run: RunRecord): Promise<void>;
  /** The sessions of this driver in a scope, also those that idfx did not start. */
  list(scope: Scope): Promise<SessionRef[]>;
  /** Events of one session for watch, log, and top, in one shared shape. */
  events(session: SessionRef, signal: AbortSignal): AsyncIterable<RunEvent>;
  /** Cost and tokens of one session tree from the cost source of the driver. */
  usage(session: SessionRef): Promise<UsageSummary>;
}
```

`RunRecord` gets the field `driver`. A record without it is an `opencode` record. `RunEvent` is the small shared shape that `top` and `watch` already use (`WatchLine`, step, tool call, finish, pending request). The `opencode` driver wraps the existing code. A fourth CLI implements the same seven members.

For the Claude drivers, `list` reads `claude agents --json`. It returns every host session with `sessionId`, `cwd`, `kind`, `name`, and `status`, including the interactive ones and the supervisor. `events` reads the transcript, and `usage` reads the proxy log (`claude-glm`) or the transcript (`claude`). `start`, `say`, and `abort` for Claude come with step 23. They use `claude --bg`, `claude -p --resume`, and `claude stop`.

How does `list` tell `claude` from `claude-glm` for a session that idfx did not start? The proxy log names the session. A session with proxy lines is `claude-glm`. Any other session is `claude`.

## 3. A decision for the user: the `claude` driver through the proxy

On 2026-10-03 the user decided that all host sessions go through the proxy. The research found three costs of that rule for sessions with a claude.ai login (the supervisor and the interactive sessions):

1. Remote Control works only with `api.anthropic.com`. Claude Code also prints a warning with another base URL (report, section 6.3).
2. The terms allow the OAuth token only for "ordinary use of Claude Code". A local proxy that forwards the token unchanged is not named. It is a gray zone, not a clear permission.
3. A dead proxy stops the supervisor and every interactive session at once.

The proxy gains nothing for these sessions, because a subscription request has no USD cost, and the transcript has the same token counts. The design therefore recommends: `claude-glm` goes through the proxy, and `claude` sessions show in `top` from `claude agents --json` and the transcript, without the proxy. This meets the goal of the decision, "every host session shows in `top`", without the three costs. Until the user decides, the design follows this recommendation, and nothing in it blocks a later move of `claude` onto the proxy.

## 4. Sub-steps

Each sub-step is one session, with tests and documentation.

1. 25b, spike (by hand, cents of GLM cost): start the host proxy by hand on port 4090. A debug switch logs the header names and the keys of the request body, never a value. Run one short `claude-glm` prompt through it. Record which session headers Claude Code 2.1.285 sends, the shape of `metadata.user_id`, and the SSE usage events of OpenRouter. Write the findings into section 6 of the report.
2. 25c, proxy: an Anthropic SSE tap reads `message_start` and `message_delta` with `usage.cost`. The proxy takes the session from the header or the body, and logs the two `x-idfx-*` headers. The key hygiene test uses fixtures from the spike.
3. 25d, host proxy: the systemd user unit, the `doctor` check and fix, the health endpoint.
4. 25e, outbox task for meta: `claude-glm` points at the host proxy, sets the custom headers, and falls back with a warning.
5. 25f, the driver interface: `RunRecord.driver`, the `Driver` type, and the `opencode` driver around the existing code. No change in behavior.
6. 25g, the read side of the Claude drivers: `list`, `events`, and `usage` from `claude agents --json`, the transcript, and the proxy log. `top` and `status` show Claude sessions.
7. Step 23 builds the write side (`start`, `say`, `abort`) and the sandbox case of `claude`.

## 5. Known gaps

- Claude Code changed `metadata.user_id` once (v2.1.78). A new change breaks the attribution. Then the tap logs `session: null`. If recent `/messages` lines have no session, `doctor` warns.
- If Anthropic changes its prices, the price table of the `claude` driver needs an update. idfx takes it from the ccusage or LiteLLM pricing data and does not keep its own copy.
- In clone mode the transcript of a sandboxed `claude` run lives in the VM. Step 23.2 decides how the host reads it.
- `claude agents --json` lists only the sessions of this machine. Each machine has its own table.
- If OpenRouter rejects a beta header, a `claude-glm` run needs `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`. The spike shows whether it does.
