---
checked: 2026-09-30
recheck: on new opencode release
decisions:
  - "stay on opencode 1.18.32"
  - "the AbortError handler in src/top/app.tsx"
---

# How `oc-sub top` reads SSE and stops it cleanly

Research for step 8e of [PLAN.md](../PLAN.md). Written 2026-09-30, against `@opencode-ai/sdk` 1.18.32 and 1.18.33, hey-api `main` (fetched 2026-09-30), opencode `main` (fetched 2026-09-30), bun 1.4.2 on Linux. Facts carry sources; guesses are marked.

## The bug, reproduced

`src/top/live.ts` calls `client.global.event()` and aborts an `AbortController` in `stop()` (`src/top/live.ts:278`). The generated SSE client of the SDK registers an abort handler that runs `void reader.cancel()` (`node_modules/@opencode-ai/sdk/dist/gen/core/serverSentEvents.gen.js`, `abortHandler`, ~line 30). `reader.cancel()` returns a promise. When the fetch body is aborted, that promise rejects with `AbortError`. The `try { ... } catch {}` around it catches nothing, because the rejection is asynchronous. Nobody handles it, and bun treats an unhandled rejection as fatal.

Reproduced with a local fake SSE server (`Bun.serve`, `text/event-stream`), bun 1.4.2, Linux:

- SDK 1.18.32, `client.global.event({ signal, onSseError, sseDefaultRetryDelay, sseMaxRetryDelay })`, abort after 900 ms → `AbortError` DOMException printed, **exit code 1**. The consumer loop had a `try/catch`, so `live.ts`'s own catch does not protect it. The rejection is created inside `ctrl.abort()`, at the SDK's abort handler.
- Same repro with a patched copy of the generated file, `reader.cancel().catch(() => {})` instead of `void reader.cancel()`, plus a catching consumer → clean end, **exit 0**. This pins the root cause: the unhandled rejection is exactly the `reader.cancel()` promise in the SDK's abort handler.
- A plain `fetch` + `TextDecoderStream` + `reader.read()` loop without the SDK, aborted mid-read, with the read rejection caught → clean end, **exit 0**. No `reader.cancel()` is needed at all; aborting the signal tears the fetch down and makes the pending `read()` reject.

Upstream evidence for the same mechanism: an opencode issue reports "unhandled rejection when SSE chunk-timeout cancels the fetch reader ... Under Bun 1.4, `reader.cancel()` on the just-aborted fetch body rejects, leaving an unhandled promise rejection" (anomalyco/opencode issue 44943, found via web search, 2026-09-30; fix direction there: `reader.cancel(err).catch(() => {})`). That issue is about opencode's own provider code, not the SDK, but it names the same bun 1.4 behavior.

## 1. Does a newer SDK or hey-api template fix it?

**No, both still have the flaw.**

- **SDK 1.18.33** (published 2026-09-28, npm `time`): its `dist/gen/core/serverSentEvents.gen.js` is **byte-identical** to 1.18.32 (verified by downloading the 1.18.33 tarball and `diff`). It is still 1.18.x latest.
- **hey-api current template**: the repository moved from `hey-api/openapi-ts` to `hey-api/hey-api` (GitHub redirect; 5,457 stars, last push 2026-08-24, latest npm release `@hey-api/openapi-ts` 0.99.0). The current template `packages/openapi-ts/src/plugins/@hey-api/client-core/bundle/serverSentEvents.ts` (fetched from `main` on 2026-09-30) still contains:

  ```ts
  const abortHandler = () => {
    try {
      reader.cancel();          // line 143 — rejection still not handled
    } catch {
      // noop
    }
  };
  ```

  The `try/catch` only catches synchronous throws; the async rejection stays unhandled. No changelog entry or issue in hey-api mentions this abort path as fixed. Related hey-api work exists but is different: PR #2970 (2025-11-12) made the fetch client intercept `AbortError` from the initial `fetch()` call, not from the SSE reader.

So neither waiting for a newer SDK nor regenerating with hey-api helps today. (Guess: a hey-api fix would reach the SDK only after opencode regenerates its client, which is outside our control.)

## 2. How opencode's own clients read and stop the stream

Checked opencode `main` on 2026-09-30 (repo `anomalyco/opencode`, formerly `sst/opencode`; 210,983 stars, pushed 2026-09-30). I did not check out tag v1.18.32 for this section; `main` is what the facts below describe, and the brief asked for both — the v1.18.32 TUI behavior is a guess marked below.

- **TUI** (`packages/tui/src/context/sdk.tsx:82-117`): solid-js, bun. It calls the **v2 SDK**, `sdk.global.event({ signal: ctrl.signal, sseMaxRetryAttempts: 0 })` — with `sseMaxRetryAttempts: 0` the SDK does **not** retry internally; the TUI retries itself: a `while (true)` loop, exponential backoff `Math.min(1000 * 2 ** (attempt - 1), 30000)`, a `break` when its own or the outer `abort.signal` is aborted, and `.catch(() => {})` on the whole async IIFE. On cleanup it calls `abort.abort()` and `sse?.abort()` (lines 134-138). So opencode's own pattern is: **SDK only as a single-shot stream, all reconnect and stop logic in the app**, and a blanket `.catch` to swallow the abort noise.
- **v2 SDK**: `packages/sdk/js/src/v2/gen/core/serverSentEvents.gen.ts:141` still has the same un-caught `reader.cancel()` in its abort handler (checked out `main`, 2026-09-30). The v1 gen on `main` (`packages/sdk/js/src/gen/core/serverSentEvents.gen.ts:114`) has `void reader.cancel()`, identical to our installed 1.18.32.
- **Guess**: because the TUI aborts on quit exactly like `live.ts` does, it should hit the same unhandled rejection under bun 1.4. Its `.catch(() => {})` covers only the IIFE's own throw, not the abort-handler rejection. Maybe the TUI crashes silently on exit today, or bun's exit path differs when the process is already tearing down. Untested; open question.

**Takeaway**: opencode's own client does not trust the SDK's retry loop either. It runs one stream attempt per iteration and owns backoff, stop, and reconnection itself. That is what `live.ts` already does for the clean-end case (lines 126-199); only the abort path is broken.

## 3. Libraries that read SSE over fetch with a clean abort

| | `eventsource-parser` | `@microsoft/fetch-event-source` | `eventsource` | bun's `EventSource` |
|---|---|---|---|---|
| Latest version / date | **4.1.1**, 2026-09-15 (npm) | 2.0.1, **2021-04-25** (npm) | **5.1.2**, 2026-09-21 (npm) | — |
| Weekly downloads | 85,767,275 (2026-09-22..28, npm API) | 4,250,138 | 72,008,358 | — |
| Maintenance | Active: 4 releases in 2026, repo pushed 2026-09-15 (rexxars/eventsource-parser, 507 stars) | **Dead**: last publish 2021-04-25, no release in 5 years | Active: repo pushed 2026-09-21 (EventSource/eventsource, 1,159 stars) | — |
| Abort support | N/A — it is only a parser; you own `fetch` and the signal, so abort is exactly as clean as your own loop | Yes, via `signal`; designed around `fetch` | Yes, `close()`; it owns the HTTP request | — |
| Reconnect support | No (by design; you own the retry loop) | Yes, built-in `onopen`/`onerror` + retry | Yes, built-in with `Last-Event-ID` | — |
| Works under bun | **Yes, tested** (repro below) | Untested; browser-oriented (`document.visibilitychange` hook), likely works for the fetch part (guess) | Untested here; uses Node `http`, not `fetch` (guess: works, but its own reconnect fights our reseed logic) | **Does not exist in bun 1.4.2**: `typeof EventSource === "undefined"` and `Bun.EventSource === undefined` (tested) |
| Custom headers (auth) | N/A (your fetch) | Yes | Yes, via its `eventSourceInit.headers` (per its README; guess, not tested) | — |

`eventsource-parser` 4.1.1 exports `createParser(config)` and `EventSourceParserStream` (a `TransformStream` from text chunks to `EventSourceMessage`) — checked in `node_modules/eventsource-parser/dist/` after installing it. The parser is pure string→event transformation with no I/O, so abort behavior is whatever your fetch loop does.

The huge download numbers of `eventsource-parser` and `eventsource` come from their use as building blocks in AI SDKs; they are the de-facto standard pair for fetch-based SSE in JS today.

## 4. Recommendation

**Read the stream in our own code with `fetch` + `eventsource-parser`, and stop it with a bare `abort()`.** Keep the SDK for all REST calls. This follows the pattern the opencode TUI uses (own the loop, don't rely on the SDK's SSE retry), removes the only code path that produces the fatal rejection, and is proven to exit 0 under bun 1.4.2 in the repro.

Why not the alternatives:

- Keep SDK + patch nothing: crashes on every quit (reproduced).
- Keep SDK + `process.on("unhandledRejection")`: masks all future unhandled rejections; rejected.
- Keep SDK + `stream.return()` before abort: fails the worst case — with a silent server the pending `reader.read()` blocks the generator's `finally`, so `return()` does not resolve (measured >2 s), and any timeout fallback aborts while the bad listener is still attached → crash again (reproduced).
- `eventsource`: its built-in reconnect has no hook for our "reseed after a gap" requirement, and it bypasses our `fetch`/auth/probe stack.
- `@microsoft/fetch-event-source`: unmaintained since 2021.

### Sketch

New small module `src/sse.ts` (fetch, auth, parse, clean stop — no retry, no reseed; the caller owns those):

```ts
import { createParser, type EventSourceMessage } from "eventsource-parser";
import { authHeaderFromEnv, type Env } from "./config";

export type SseSubscription = { stop(): void };

/** One GET /global/event stream. `onMessage` gets each parsed `data` JSON string. */
export function subscribeGlobalEvents(
  baseUrl: string,
  env: Env,
  onMessage: (message: EventSourceMessage) => void,
  onEnded: () => void,          // stream ended or failed; caller decides reconnect
): SseSubscription {
  const controller = new AbortController();
  const auth = authHeaderFromEnv(env);
  void (async () => {
    try {
      const response = await fetch(`${baseUrl}/global/event`, {
        headers: { accept: "text/event-stream", ...(auth === undefined ? {} : { Authorization: auth }) },
        signal: controller.signal,
      });
      if (!response.ok || response.body === null) throw new Error(`SSE failed: ${response.status}`);
      const parser = createParser({ onEvent: onMessage });
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(value);
      }
    } catch {
      // AbortError on stop; fetch or parse failure on a dead server.
      // Either way: the stream is over, the caller reconnects.
    } finally {
      onEnded();
    }
  })();
  return { stop: () => controller.abort() };
}
```

`live.ts` changes: in `runStream`, replace the `client.global.event(...)` + iterator block with one `subscribeGlobalEvents(url, env, ...)` call; `onMessage` parses `JSON.parse(message.data)` into the `GlobalEvent` shape and calls the existing `applyItem`/reseed logic; `onEnded` sets `needsReconnect = true`. `stop()` keeps calling `entry.controller?.abort()` — with this client, abort is safe: the pending `read()` rejects, our `catch` swallows it, nothing is left unhandled (proven in the repro, flowing and silent server, exit 0).

**What `live.ts` must do itself** (mostly already there):

- Reconnect with a growing delay: already implemented (lines 139-148, 1 s doubling to 30 s). The SDK's `sseDefaultRetryDelay`/`sseMaxRetryDelay` disappear from the call; the server's `retry:` field is then ignored — acceptable, our cap is the same 30 s. (Guess: opencode's heartbeat is every 10 s, `handlers/global.ts:28-42` per top-view.md section 6.2; a dead connection is noticed only on the next failed fetch or via the existing probes.)
- Reseed after every gap: already implemented; now it also covers the previously SDK-healed mid-stream errors, because those now always end the stream (simpler: one reconnect path instead of two).
- Map non-200 to `unauthorized`/`down` like `probeServer` does (`src/client.ts:21-33`), so a wrong-key server shows a warning instead of a retry loop.
- Optional: a read-timeout (`AbortSignal.timeout` combined with the stop signal via `AbortSignal.any`) to detect a stalled connection between heartbeats. Not needed for the first version; the step 6 stall detection covers the session level.

### Test plan (for the implementation step, not done here)

A fake `Bun.serve` SSE endpoint in `bun test`: events arrive and reach the model; `stop()` while events flow exits the loop and the process exits 0; `stop()` while the server is silent also exits 0; a non-200 answer reports `unauthorized`.

## Open questions

1. Does the opencode TUI actually crash on quit under bun 1.4 (same abort path)? Guess above says it should; not tested.
2. Did the web app (`packages/app` or similar) choose a different SSE client? Not examined; the TUI pattern was enough for the recommendation.
3. Will hey-api fix the abort handler, and will opencode regenerate the SDK from it? Unknown; re-check if a newer SDK lands after 1.18.33.
4. The repro ran on bun 1.4.2 / Linux. The exact rejection semantics of `reader.cancel()` on an aborted fetch body may differ on other runtimes (Node was not tested); our own-loop fix does not depend on them.
