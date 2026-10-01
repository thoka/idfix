---
checked: 2026-09-28
recheck: on new opencode release
decisions:
  - "stay on opencode 1.18.32"
---

# Answering a subagent's questions and permission requests as the orchestrator

Research date: 2026-09-28. Written by the `researcher` opencode agent (step 4 of [PLAN.md](../PLAN.md)).

Question: how do established tools let an orchestrator answer the question or the permission request of a subagent that runs without a human?

Facts carry a source (URL, file with line number, or a fetched raw source file). Statements marked **[guess]** are judgment. Words: ~1,900.

## 0. Short answers

1. opencode 1.18.32 already has the full channel, server-side. The `question` tool and `ask` permissions pause the run until answered. The server publishes SSE events (`question.asked`, `permission.asked`, ...), lists pending requests (`GET /question`, `GET /permission`), and takes answers (`POST /question/:requestID/reply`, `POST /permission/:requestID/reply`). Nothing times out. `GET /session/status` shows only `idle|retry|busy` — a paused session stays `busy`, so the pending state is only visible via the two list endpoints or the events. (Section 1)
2. The published v1 SDK gen in `@opencode-ai/sdk@1.18.32` is stale: it lacks the question routes and list endpoints. The `./v2` export of the same package has them. `oc-sub` can call the routes with raw fetch (it already does for `/global/health`). (Section 1.4)
3. `opencode-mcp` exposes `opencode_question_list/reply/reject` and `opencode_permission_list` + `opencode_session_permission`, detects pending input by polling every 1–2 s, and synthesizes the job state `input_required`. (Section 2)
4. Claude Agent SDK (`canUseTool`), ACP (`session/request_permission`), A2A (`input-required`), MCP elicitation, OpenAI Agents SDK (`RunState` interruptions), and LangGraph (`interrupt`) all share one pattern: a structured request with options, execution paused, the request visible to an orchestrator via a queue or event, a structured reply that resumes the run, and no timeout. (Sections 3–4)
5. `oc-sub` can reuse opencode's server machinery entirely. It must build only the watch-side detection and the answer command. Proposed design in Section 5.

## 1. opencode 1.18.32

### 1.1 The `question` tool

`packages/opencode/src/tool/question.ts` delegates to a separate `Question` service, **not** to the permission system ([source, tag v1.18.32](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.32/packages/opencode/src/tool/question.ts)):

```ts
const answers = yield* question.ask({
  sessionID: ctx.sessionID,
  questions: params.questions,
  tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
})
```

The service (`packages/opencode/src/question/index.ts`) stores the request in a `pending` map with an Effect `Deferred`, publishes the event, and blocks the tool call: `return yield* Effect.ensuring(Deferred.await(deferred), ...)` ([source](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.32/packages/opencode/src/question/index.ts)). So during `opencode serve`, the run pauses until a client replies over HTTP; no TUI is needed. The TUI itself answers through the same HTTP endpoints (`sdk.client.question.reply(...)` in `packages/tui/src/routes/session/question.tsx`).

A question request carries ([packages/schema/src/v1/question.ts](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.32/packages/schema/src/v1/question.ts)):

- `id` — `"que_"`-prefixed, `QuestionID.ascending()`
- `sessionID`
- `questions[]` — each `{ question, header, options: [{label, description}], multiple?, custom? }`
- `tool?` — `{ messageID, callID }` of the tool call that asked

A reply is `answers: string[][]` — per question, the selected labels in order. Reject makes the tool call fail with `QuestionRejectedError` ("The user dismissed this question"), and the agent continues and can react to the failure.

### 1.2 The `ask` permission

When a permission rule matches with `"ask"`, the permission service publishes `permission.asked` and blocks the tool call the same way (`packages/opencode/src/permission/index.ts`). The request carries `{ id, sessionID, permission, patterns, metadata, always, tool? }` ([packages/schema/src/v1/permission.ts](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.32/packages/schema/src/v1/permission.ts)). The reply values are `"once" | "always" | "reject"` plus an optional `message`. A `reject` rejects **all** pending permissions of the session.

### 1.3 Server events, endpoints, status

SSE stream `GET /event` publishes ([routes in packages/opencode/src/server/routes/instance/httpapi/groups/](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.32/packages/opencode/src/server/routes/instance/httpapi/groups/question.ts), [permission.ts](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.32/packages/opencode/src/server/routes/instance/httpapi/groups/permission.ts)):

| Event | Payload fields |
| --- | --- |
| `question.asked` | `{id, sessionID, questions[], tool?}` |
| `question.replied` | `{sessionID, requestID, answers}` |
| `question.rejected` | `{sessionID, requestID}` |
| `permission.asked` | `{id, sessionID, permission, patterns, metadata, always, tool?}` |
| `permission.replied` | `{sessionID, requestID, reply}` |

Endpoints:

- `GET /question` — list pending questions across all sessions; `GET /permission` — same for permissions.
- `POST /question/:requestID/reply` — body `{answers: string[][]}`; `POST /question/:requestID/reject` — no body.
- `POST /permission/:requestID/reply` — body `{reply: "once"|"always"|"reject", message?}`.
- `POST /session/:id/permissions/:permissionID` — the older reply route, still present but marked `deprecated: true` (groups/session.ts). Body `{response: "once"|"always"|"reject"}`.
- There is **no per-session pending list**; only the two global lists, filtered client-side by `sessionID`.

`GET /session/status` returns per-session `SessionStatus` with only three variants: `{type: "idle"}`, `{type: "retry", attempt, message, next}`, `{type: "busy"}` ([packages/schema/src/session-status-event.ts](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.32/packages/schema/src/session-status-event.ts)). **There is no "waiting for permission/question" state.** A paused session reports `busy`, because the tool call is still running. A watcher can therefore not learn about a pending request from the status map — it needs the events or the list endpoints.

Timeouts: none in either service. The pending entry resolves only by reply/reject; the only automatic resolution is instance disposal, which fails all pending deferreds ([question/index.ts](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.32/packages/opencode/src/question/index.ts), permission/index.ts finalizer).

### 1.4 The published SDK is stale — implementation caveat

The locally installed `@opencode-ai/sdk@1.18.32` (`node_modules/@opencode-ai/sdk`) shows the gap between the published v1 gen and the server source:

- The root (v1) export has **no** question endpoints and no `GET /permission`. It has only `POST /session/{id}/permissions/{permissionID}` with body `{response: "once"|"always"|"reject"}` (`dist/gen/sdk.gen.js` line 853, `types.gen.d.ts` lines 2510–2522) and old event names (`permission.updated`, `permission.replied` with `{sessionID, permissionID, response}` — `types.gen.d.ts` lines 384–395).
- The `./v2` export of the same package has the current surface: `GET /question`, `POST /question/{requestID}/reply|reject`, `GET /permission`, `POST /permission/{requestID}/reply` (`dist/v2/gen/sdk.gen.js` lines 1711–1850), plus `QuestionInfo`/`QuestionRequest` types.

Verified: the tag `v1.18.32` (commit `545f51d2`) contains `groups/question.ts` with the three `/question` routes, byte-identical at `v1.18.25` and on `dev`. So the 1.18.x server serves these routes, but the v1 SDK gen was generated from an older spec. **[fact]** `oc-sub` must either use the `./v2` export client or raw-fetch these routes (precedent: `probeServer` already raw-fetches `/global/health`, `src/client.ts` line 27). **[guess]** Event payload shapes emitted by a live 1.18.32 server should be verified once against `GET /doc` or a test run before wiring the watcher, because the stale gen's `permission.updated` vs source `permission.asked` shows the two surfaces disagree.

## 2. opencode-mcp

Source: repo [AlaeddineMessadi/opencode-mcp](https://github.com/AlaeddineMessadi/opencode-mcp) v3.0.0, files `src/tools/input.ts`, `src/tools/session.ts`, `src/jobs.ts`, `src/tools/workflow.ts`.

- Tools: `opencode_question_list` (`sessionId?`, `directory?`), `opencode_question_reply` (`requestId`, `answers: string[][]`), `opencode_question_reject` (`requestId`); `opencode_permission_list` (`directory`), `opencode_session_permission` (`id`, `permissionID`, `reply: once|always|reject`); combined `opencode_job_input` (`jobId`, optional `responses`) for both kinds.
- Endpoints called: same as Section 1.3 — `GET /question`, `GET /permission`, `POST /question/{id}/reply|reject`, `POST /permission/{id}/reply` with a fallback to the deprecated session route.
- Detection is **polling**: `waitForSnapshot` loops with 1–2 s intervals and returns on `["completed", "failed", "cancelled", "input_required"]`; each poll reads status, messages, and both pending lists, and sets `snapshot.status = "input_required"` when the watched session has pending inputs. SSE exists only as a separate manual event collector (`opencode_events_poll`). The README states: "Task status is retrieved by polling; this package does not promise to wake an idle assistant with completion notifications."
- It returns the pending requests to Claude Code as structured JSON (question list) or formatted text with a hint which tool to call next (permission list). `opencode_job_input` can return MCP elicitation forms when the client supports them.

**Takeaway:** the mapping "session has pending input ⇒ synthesized job state `input_required`" is exactly the A2A state name (Section 3.3), and it works well enough that polling is acceptable — but oc-sub already has a live SSE stream in `watch`, so it can be event-driven instead.

## 3. Other tools

### 3.1 Claude Agent SDK — `canUseTool`

Source: [Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input), [Configure permissions](https://code.claude.com/docs/en/agent-sdk/permissions).

- When the permission flow falls through to a prompt (after hooks, deny rules, ask rules, permission mode, allow rules), the SDK invokes `canUseTool(toolName, input, {signal, suggestions?})`.
- The callback returns `{behavior: "allow", updatedInput, updatedPermissions?}` or `{behavior: "deny", message}`.
- "Both trigger your `canUseTool` callback, which pauses execution until you return a response." "The callback can stay pending indefinitely." For long waits the docs recommend a `PreToolUse` hook returning `defer`, "so the process can exit and resume later from the persisted session."

### 3.2 Agent Client Protocol — `session/request_permission`

Source: [Tool Calls / Requesting Permission](https://agentclientprotocol.com/protocol/v1/tool-calls) (v1).

- The **agent** sends a JSON-RPC request `session/request_permission` to the **client** before executing a tool call. Params: `sessionId`, `toolCall` (ToolCallUpdate), `options[]` with `{optionId, name, kind: allow_once|allow_always|reject_once|reject_always}`.
- The client replies `{"outcome": {"outcome": "selected", "optionId": "..."}}` or `{"outcome": {"outcome": "cancelled"}}`.
- No timeout; a pending tool call keeps status `pending`. Clients "MAY automatically allow or reject permission requests according to the user settings". If the prompt turn is cancelled, the client MUST answer `cancelled`.
- ACP also has an elicitation method (`elicitation/create`, form or URL mode) — the same pause-and-ask shape for arbitrary input. A v2 draft (RFD, 2026-07-02) generalizes the request beyond tool calls with `title`/`description`/`subject`.

### 3.3 A2A protocol — `input-required`

Source: [A2A specification 1.0.0, §3.4.3](https://a2aproject.github.io/A2A/latest/specification/).

- "Agents can request additional input mid-processing by transitioning a task to the `input-required` state. The client continues the interaction by sending a new message with the same `taskId` and `contextId`."
- `input-required` is an interrupted, non-terminal state. A blocking call "MUST wait until the task reaches a terminal state ... or an interrupted state (`TASK_STATE_INPUT_REQUIRED`, ...)" before returning; a non-blocking caller polls `GetTask`. The SSE stream closes when the state is reached. No timeout is defined.

### 3.4 MCP elicitation

Source: [MCP spec 2025-06-18, client/elicitation](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation).

- A server sends `elicitation/create` with `{message, requestedSchema}` — the schema is limited to flat objects with primitive properties (string with formats, number, boolean, enum).
- The client responds `action: "accept" | "decline" | "cancel"`, with data on accept.
- The tool call processing pauses while the request is out ("Server: Continue processing with new information" after the response). No timeout specified; clients should allow declining at any time.

### 3.5 OpenAI Agents SDK — tool approval

Source: [Human-in-the-loop guide (Python)](https://openai.github.io/openai-agents-python/human_in_the_loop/).

- A tool declares `needs_approval` (always, or an async predicate). When approval is needed, "execution pauses, and `RunResult.interruptions` contains `ToolApprovalItem` entries".
- The orchestrator converts the result to a `RunState` (`result.to_state()`), calls `state.approve(...)` or `state.reject(...)`, and resumes with `Runner.run(agent, state)`. `state.to_json()` lets the paused run survive a process restart. The JS SDK mirrors this flow.

### 3.6 LangGraph — `interrupt`

Source: [LangGraph human-in-the-loop docs](https://docs.langchain.com/oss/python/langgraph/human-in-the-loop), [interrupt reference](https://reference.langchain.com/python/langgraph/types/interrupt).

- A node calls `interrupt(payload)`; the runtime raises an exception, persists the graph state with a checkpointer, and "waits indefinitely until you resume execution".
- Resume: re-invoke the graph with `Command(resume=<value>)` and the same `thread_id`; the resumed value becomes the return value of the `interrupt()` call. The node restarts from the beginning on resume.

## 4. The shared pattern

Six implementations, one shape:

1. **A structured request with options.** The agent does not get an error; it raises a typed request carrying enough context to decide: question with labeled options (opencode `question`, ACP options, MCP elicitation schema, A2A input-required + message), or a permission with allow/reject choices (opencode `ask`, `canUseTool` suggestions, ACP kinds, OpenAI `needs_approval`).
2. **Execution blocks.** The tool call stays pending; the agent session is paused, not failed. Whether that is an in-process `Deferred` (opencode), a paused SDK run (Claude SDK), or serialized state (OpenAI `RunState`, LangGraph checkpoint) is an implementation detail.
3. **The request is visible to an external orchestrator** through a list/queue API or an event stream, keyed by session or task ID — so a *program*, not a human, can discover it.
4. **A structured reply resumes the run.** Selected labels, `allow/deny`, `once/always/reject`, `Command(resume=...)`, or a new message with the same task ID. A reject/cancel is a clean, first-class outcome — the agent sees a rejection and can react, not a crash.
5. **No timeout.** Every one of them waits indefinitely; the orchestrator is responsible for answering or cancelling. Claude SDK's `defer` hook is the only documented "give up the process" escape hatch.

**What oc-sub can reuse directly:** the entire server side of opencode — the `question` tool, `ask` rules, the SSE events, the two list endpoints, and the two reply endpoints. Nothing else needs to be built for the pause-and-answer mechanism itself.

**What oc-sub must build itself:** (a) the agent-file policy that lets agents ask (`question: allow`, `ask` instead of `deny` for risky commands); (b) detection in `watch` — today it only ends on `session.idle` (`src/watch.ts` line 100) and prints nothing for permission/question events (`src/events.ts` `watchEventLine` has no cases for them); (c) a CLI to list pending requests and answer them, because the v1 SDK gen lacks those routes (Section 1.4); (d) a distinct exit signal so Claude Code's background watch notices the pause.

## 5. Proposed design for oc-sub

**Agent files.** In `opencode/agents/researcher.md` and `reader.md`: change `question: deny` to `question: allow`. In the `bash`/`edit` maps, replace the `"*": deny` catch-all with `"*": ask` (keeping the specific `allow` rules and the `deny` for `.env` reads), so a command outside the allowlist pauses instead of erroring. `reader.md` keeps everything denied — it is a single-purpose fetcher. Update `skills/oc-sub/reference.md` ("Use `deny` instead of `ask`...") and the brief template to the new policy, with the note that a run may pause and how to answer.

**`oc-sub watch`.** Handle `question.asked` and `permission.asked` events for the watched session (and, after step 2, its child sessions): print one line with the kind, request ID, and content — e.g. `question que_123: "Which file should I edit?" [Option A / Option B]` or `permission per_456: bash "rm build/tmp.txt"` — then end the watch with exit code 3 ("paused") and a final line telling the orchestrator the exact answer command. The session status stays `busy` (Section 1.3), so the pause must be event-driven, not polled from `/session/status`. After the answer, the orchestrator starts `watch` again to follow the rest of the run.

**`oc-sub answer`.** One command, auto-detecting the kind by listing `GET /question` and `GET /permission` and matching the request ID (robust against unknown ID prefixes):

```
oc-sub answer <requestID> [--dir DIR] --label "Option A"   # question: select labels
oc-sub answer <requestID> --labels "A" --labels "B"         # multi-question / multiple
oc-sub answer <requestID> --once | --always | --reject      # permission
```

For questions it posts `{answers: [[label], ...]}`; for permissions `{reply: "once"|"always"|"reject"}`. `--reject` on a question posts the reject endpoint. Print the reply event confirmation and remind to re-run `watch`. The calls go through raw fetch (or the SDK `./v2` export) since the v1 gen lacks the routes; verify exact route behavior against the live server in the first implementation step.

**What stays a user decision:** whether `watch` should exit on pause (my recommendation, so Claude Code gets a background-task notification) or keep waiting and only print; and which commands move from `deny` to `ask` per agent.

## 6. Open questions

Status after the implementation of step 4 (2026-09-28). The integration test against a real `opencode serve` 1.18.32 server answered the first two.

- ~~Whether `GET /permission` / `GET /question` accept a `directory` query parameter like other instance routes.~~ **Answered.** Both endpoints answer HTTP 200 with `[]` with the `directory` query and without it (test/integration.test.ts). Whether the server *filters* by directory stays unverified, because a pending request is needed to tell filtering from ignoring. `oc-sub` sends the directory everywhere, so it works in both cases.
- ~~Whether a question asked inside a child (`task`) session surfaces through `GET /question` and the global event stream.~~ **Still open.** Creating a real pending request needs a model call, which the tests must not make. The watch side is covered: the filter checks the request's `sessionID` against the watched session and all of its descendants (test/watch-pending.test.ts), so a request of a child session is found as soon as the server lists it.
- Exact live event names and payload shapes of a 1.18.32 server (`permission.asked` vs the stale gen's `permission.updated`). Still unverified. The watcher no longer depends on them: it treats both event types as a trigger to re-read the two lists, and the 2 second status poll is the fallback that catches everything.
- Whether the `./v2` export client of `@opencode-ai/sdk@1.18.32` works unchanged against a 1.18.x server. **Decided without testing it:** `oc-sub` uses raw fetch for these routes, like `probeServer` for the health check (src/requests.ts). The v2 client stays unused.
- The ID prefix of permission requests (`que_` for questions is confirmed). Still unverified. `oc-sub answer` does not guess from the prefix, it looks the ID up in both lists.

## 7. Sources

- opencode source, tag v1.18.32 (commit `545f51d26cc39a907d2867492d498d9607ea5fa4`; routes byte-identical at v1.18.25 and on `dev`): [tool/question.ts](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.32/packages/opencode/src/tool/question.ts), [question/index.ts](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.32/packages/opencode/src/question/index.ts), [permission/index.ts](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.32/packages/opencode/src/permission/index.ts), [schema/src/v1/question.ts](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.32/packages/schema/src/v1/question.ts), [schema/src/v1/permission.ts](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.32/packages/schema/src/v1/permission.ts), [schema/src/session-status-event.ts](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.32/packages/schema/src/session-status-event.ts), [routes/groups/question.ts](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.32/packages/opencode/src/server/routes/instance/httpapi/groups/question.ts), [routes/groups/permission.ts](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.32/packages/opencode/src/server/routes/instance/httpapi/groups/permission.ts), [tui/src/routes/session/question.tsx](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.32/packages/tui/src/routes/session/question.tsx)
- Local: `node_modules/@opencode-ai/sdk@1.18.32` (`dist/gen/sdk.gen.js` line 853, `dist/gen/types.gen.d.ts` lines 369–412, 2510–2540; `dist/v2/gen/sdk.gen.js` lines 1711–1850, `dist/v2/gen/types.gen.d.ts` lines 522–552, 5047–5068); `src/client.ts` line 27; `src/watch.ts` line 100; `src/events.ts` lines 92–115; `opencode/agents/researcher.md` lines 21–28; `mise.toml` line 3
- opencode-mcp: [README](https://raw.githubusercontent.com/AlaeddineMessadi/opencode-mcp/main/README.md), [src/tools/input.ts](https://raw.githubusercontent.com/AlaeddineMessadi/opencode-mcp/main/src/tools/input.ts), [src/tools/session.ts](https://raw.githubusercontent.com/AlaeddineMessadi/opencode-mcp/main/src/tools/session.ts), [src/jobs.ts](https://raw.githubusercontent.com/AlaeddineMessadi/opencode-mcp/main/src/jobs.ts), [src/tools/workflow.ts](https://raw.githubusercontent.com/AlaeddineMessadi/opencode-mcp/main/src/tools/workflow.ts), [docs/examples.md](https://raw.githubusercontent.com/AlaeddineMessadi/opencode-mcp/main/docs/examples.md)
- Claude Agent SDK: [user-input](https://code.claude.com/docs/en/agent-sdk/user-input), [permissions](https://code.claude.com/docs/en/agent-sdk/permissions), [typescript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- ACP: [Tool Calls v1](https://agentclientprotocol.com/protocol/v1/tool-calls), [Elicitation](https://agentclientprotocol.com/protocol/v1/elicitation), [v2 Permission Requests RFD](https://agentclientprotocol.com/rfds/v2/permission-requests.md)
- A2A: [specification 1.0.0](https://a2aproject.github.io/A2A/latest/specification/), [streaming and async](https://a2aproject.github.io/A2A/latest/topics/streaming-and-async/)
- MCP: [elicitation](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation), [sampling](https://modelcontextprotocol.io/specification/2025-06-18/client/sampling)
- OpenAI Agents SDK: [human in the loop](https://openai.github.io/openai-agents-python/human_in_the_loop/)
- LangGraph: [human-in-the-loop](https://docs.langchain.com/oss/python/langgraph/human-in-the-loop), [interrupt reference](https://reference.langchain.com/python/langgraph/types/interrupt)