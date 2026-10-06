/**
 * The cost proxy: a small Bun HTTP pass-through between a coding agent and
 * its model providers, OpenRouter and DeepInfra. opencode calls the OpenAI
 * shape (`/v1/chat/completions`), Claude Code calls the Anthropic shape
 * (`/v1/messages`). A request path that starts with `/deepinfra/` goes to
 * DeepInfra with that prefix removed. Every other path goes to OpenRouter.
 * The proxy forwards every request to the upstream base URL, streams the
 * response back without buffering, and writes one JSON log line per request
 * event to stdout (tagged with `"source":"idfx-cost-proxy"`). See
 * .plan/research/cost-proxy.md and .plan/design/driver-layer.md.
 *
 * Key safety: the proxy logs the value of no header outside this allowlist:
 * `X-Session-Id`, `x-parent-session-id`, `x-claude-code-session-id`,
 * `x-claude-code-agent-id`, `x-idfx-run`, and `x-idfx-project`. It never
 * logs `Authorization`, `x-api-key`, or a body. The one body read is the
 * session fallback of a Claude Code request: when the session headers are
 * missing, the proxy parses `metadata.user_id` of a `POST .../messages` body
 * in memory and logs only its `session_id`, never `device_id` or
 * `account_uuid`.
 *
 * `HEAD /api/hello` is the reachability probe of Claude Code. The proxy
 * answers it with 200 itself, with no upstream call and no log line.
 */
import { applyChunk, createSseTap, type TapResult } from "./tap";

export const LOG_SOURCE = "idfx-cost-proxy";
/**
 * The log source of the proxy before step 24.3. A running sandbox proxy
 * keeps its old bundle until its restart, so the readers accept both.
 */
export const OLD_LOG_SOURCE = "oc-sub-cost-proxy";

/** Whether a log line value is the source of the cost proxy, new or old. Pure. */
export function isProxyLogSource(source: unknown): boolean {
  return source === LOG_SOURCE || source === OLD_LOG_SOURCE;
}

/**
 * The upstream origin plus the prefix in front of the API version. opencode
 * points its base URL at `http://127.0.0.1:PORT/v1`, so the request path
 * already starts with `/v1`, and the proxy appends it to this value:
 * `/v1/chat/completions` goes to `https://openrouter.ai/api/v1/chat/completions`.
 */
export const DEFAULT_UPSTREAM = "https://openrouter.ai/api";

/**
 * The DeepInfra origin. opencode points the deepinfra provider at
 * `http://127.0.0.1:PORT/deepinfra/v1`, and its SDK appends
 * `/openai/chat/completions`. The proxy removes the `/deepinfra` prefix, so
 * `/deepinfra/v1/openai/chat/completions` goes to
 * `https://api.deepinfra.com/v1/openai/chat/completions`.
 */
export const DEFAULT_DEEPINFRA_UPSTREAM = "https://api.deepinfra.com";

/** The path prefix that selects the DeepInfra upstream. */
export const DEEPINFRA_PREFIX = "/deepinfra";

/** The name of an upstream, as the `upstream` field of each log line shows it. */
export type UpstreamName = "openrouter" | "deepinfra";

/**
 * The upstream of one request path and the URL the proxy fetches. Pure.
 * Only `/deepinfra` itself and paths below `/deepinfra/` go to DeepInfra, so
 * a path such as `/deepinfra-x` still goes to OpenRouter.
 */
export function routeRequest(
  pathname: string,
  search: string,
  upstream: string,
  deepinfraUpstream: string,
): { upstream: UpstreamName; target: string } {
  if (pathname === DEEPINFRA_PREFIX || pathname.startsWith(`${DEEPINFRA_PREFIX}/`)) {
    return { upstream: "deepinfra", target: deepinfraUpstream + pathname.slice(DEEPINFRA_PREFIX.length) + search };
  }
  return { upstream: "openrouter", target: upstream + pathname + search };
}

export interface StartProxyOptions {
  port: number;
  hostname?: string;
  upstream?: string;
  /** The DeepInfra origin; the default is `DEFAULT_DEEPINFRA_UPSTREAM`. */
  deepinfraUpstream?: string;
  /** Writes one log line per event. Default: `console.log(JSON.stringify(line))`. */
  log?: (line: Record<string, unknown>) => void;
  /** Upstream fetch, injectable for tests. */
  fetchImpl?: typeof fetch;
}

type RequestState = {
  request: number;
  upstream: UpstreamName;
  session: string | null;
  parentSession: string | null;
  /** The subagent id of a Claude Code request (`x-claude-code-agent-id`). */
  agent: string | null;
  /** The idfx run id (`x-idfx-run`), set by the driver as a custom header. */
  idfxRun: string | null;
  /** The idfx project (`x-idfx-project`), set by the driver as a custom header. */
  idfxProject: string | null;
  method: string;
  path: string;
  startedAt: number;
};

/** Whether the proxy answers this request itself: the Claude Code probe `HEAD /api/hello`. Pure. */
export function isHelloProbe(method: string, pathname: string): boolean {
  return method === "HEAD" && pathname === "/api/hello";
}

/** Whether a request may carry the Claude Code session in its body. Pure. */
export function mayCarryBodySession(method: string, pathname: string): boolean {
  return method === "POST" && pathname.endsWith("/messages");
}

/**
 * The `session_id` inside `metadata.user_id` of an Anthropic request body,
 * else null. Claude Code sends `user_id` as a JSON string with `device_id`,
 * `account_uuid`, and `session_id` (.plan/research/driver-interface.md
 * sections 6.1 and 6.9). Only `session_id` leaves this function. Never
 * throws. Pure.
 */
export function bodySessionId(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { metadata?: { user_id?: unknown } } | null;
    const userId = parsed?.metadata?.user_id;
    if (typeof userId !== "string") return null;
    const inner = JSON.parse(userId) as { session_id?: unknown } | null;
    const session = inner?.session_id;
    return typeof session === "string" && session !== "" ? session : null;
  } catch {
    return null;
  }
}

/** The value of a header, null when it is absent or empty. */
function headerOf(headers: Headers, name: string): string | null {
  const value = headers.get(name);
  return value === null || value === "" ? null : value;
}

export function startProxy({
  port,
  hostname = "127.0.0.1",
  upstream = DEFAULT_UPSTREAM,
  deepinfraUpstream = DEFAULT_DEEPINFRA_UPSTREAM,
  log = (line) => console.log(JSON.stringify(line)),
  fetchImpl = fetch,
}: StartProxyOptions): Bun.Server<never> {
  let nextRequest = 1;

  const writeEnd = (
    state: RequestState,
    tap: TapResult,
    status: number | null,
    firstByteAt: number | null,
    error: string | null,
  ): void => {
    log({
      source: LOG_SOURCE,
      event: "end",
      time: new Date().toISOString(),
      request: state.request,
      upstream: state.upstream,
      session: state.session,
      parentSession: state.parentSession,
      agent: state.agent,
      idfxRun: state.idfxRun,
      idfxProject: state.idfxProject,
      method: state.method,
      path: state.path,
      status,
      latencyMs: firstByteAt === null ? null : Math.round(firstByteAt - state.startedAt),
      durationMs: Math.round(performance.now() - state.startedAt),
      generation: tap.generation,
      provider: tap.provider,
      model: tap.model,
      cost: tap.usage.cost,
      upstreamCost: tap.usage.upstreamCost,
      tokens: {
        input: tap.usage.input,
        output: tap.usage.output,
        reasoning: tap.usage.reasoning,
        cached: tap.usage.cached,
      },
      finishReason: tap.finishReason,
      error,
    });
  };

  return Bun.serve({
    port,
    hostname,
    // Bun's default idle timeout is 10 seconds. A model provider can send no
    // byte for much longer (Z.AI p99 time to first byte is about 21 s, see
    // .plan/research/provider-probe.md), so the default would cut the
    // connection before the first chunk. 0 disables the timeout (the option
    // is in seconds; 255 is its maximum, 0 turns it off).
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      // Claude Code probes the base URL before its first request. The probe
      // is no model call, so it costs nothing and gets no log line.
      if (isHelloProbe(req.method, url.pathname)) return new Response(null, { status: 200 });
      const route = routeRequest(url.pathname, url.search, upstream, deepinfraUpstream);
      // The session: the opencode header, else the Claude Code header, else
      // the session_id in the body of a Claude Code request. The body is
      // read only in that last case, and the same bytes go upstream.
      let session = headerOf(req.headers, "X-Session-Id") ?? headerOf(req.headers, "x-claude-code-session-id");
      let body: ReadableStream<Uint8Array> | ArrayBuffer | null = req.body;
      if (session === null && req.body !== null && mayCarryBodySession(req.method, url.pathname)) {
        const bytes = await req.arrayBuffer();
        session = bodySessionId(new TextDecoder().decode(bytes));
        body = bytes;
      }
      const state: RequestState = {
        request: nextRequest++,
        upstream: route.upstream,
        session,
        parentSession: headerOf(req.headers, "x-parent-session-id"),
        agent: headerOf(req.headers, "x-claude-code-agent-id"),
        idfxRun: headerOf(req.headers, "x-idfx-run"),
        idfxProject: headerOf(req.headers, "x-idfx-project"),
        method: req.method,
        path: url.pathname + url.search,
        startedAt: performance.now(),
      };
      log({
        source: LOG_SOURCE,
        event: "start",
        time: new Date().toISOString(),
        request: state.request,
        upstream: state.upstream,
        session: state.session,
        parentSession: state.parentSession,
        agent: state.agent,
        idfxRun: state.idfxRun,
        idfxProject: state.idfxProject,
        method: state.method,
        path: state.path,
      });

      const headers = new Headers(req.headers);
      headers.delete("host");
      // Bun's fetch transparently decompresses the upstream body, so the
      // bytes the proxy forwards are plain. Ask for plain bytes and strip
      // every encoding-related hop-by-hop header from the answer.
      headers.delete("accept-encoding");
      let res: Response;
      try {
        res = await fetchImpl(route.target, {
          method: req.method,
          headers,
          body,
          redirect: "manual",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeEnd(state, createSseTap().result(), null, null, `upstream fetch failed: ${message}`);
        return Response.json({ error: { message: `upstream fetch failed: ${message}` } }, { status: 502 });
      }

      const status = res.status;
      const contentType = res.headers.get("content-type") ?? "";
      const responseHeaders = new Headers(res.headers);
      responseHeaders.delete("content-length");
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("transfer-encoding");

      if (contentType.includes("text/event-stream") && res.body !== null) {
        // Pass-through: every byte goes on at once, the tap only watches.
        const tap = createSseTap();
        // One decoder per stream: a streaming decoder keeps a cut multibyte
        // character between reads, so two streams must not share one.
        const decoder = new TextDecoder();
        let firstByteAt: number | null = null;
        const reader = res.body.getReader();
        let settled = false;
        const finish = (error: string | null) => {
          if (settled) return;
          settled = true;
          writeEnd(state, tap.result(), status, firstByteAt, error);
        };
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                finish(tap.result().error);
                controller.close();
                return;
              }
              if (firstByteAt === null) firstByteAt = performance.now();
              tap.push(decoder.decode(value, { stream: true }));
              controller.enqueue(value);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              finish(message);
              // Surface the failure to the client instead of a clean end,
              // which would make a cut answer look complete.
              controller.error(error);
            }
          },
          async cancel(reason) {
            finish(reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "client aborted");
            try {
              await reader.cancel();
            } catch {
              // The upstream stream may already be gone.
            }
          },
        });
        return new Response(stream, { status, headers: responseHeaders });
      }

      // Non-streaming: read the JSON body and take the same fields from it.
      const tap = createSseTap().result();
      let error: string | null = null;
      let firstByteAt: number | null = null;
      let text = "";
      try {
        text = await res.text();
        firstByteAt = performance.now();
        if (text !== "" && contentType.includes("json")) {
          applyChunk(tap, JSON.parse(text) as unknown);
        }
        if (status >= 400) error = res.statusText || `HTTP ${status}`;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      writeEnd(state, tap, status, firstByteAt, error);
      return new Response(text, { status, headers: responseHeaders });
    },
  });
}
