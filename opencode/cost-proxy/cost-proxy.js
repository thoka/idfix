// @bun
// node_modules/eventsource-parser/dist/errors.js
class ParseError extends Error {
  constructor(message, options) {
    super(message);
    this.name = "ParseError";
    this.type = options.type;
    this.field = options.field;
    this.value = options.value;
    this.line = options.line;
  }
}

// node_modules/eventsource-parser/dist/parse.js
var LF = 10;
var CR = 13;
var SPACE = 32;
var MAX_FIELD_PREFIX_LENGTH = 6;
function createParser(config) {
  if (typeof config === "function") {
    throw new TypeError("`config` must be an object, got a function instead. Did you mean `createParser({onEvent: fn})`?");
  }
  const { maxBufferSize, onComment, onError, onEvent, onId, onRetry } = config;
  const pendingFragments = [];
  let pendingFragmentsLength = 0;
  let bomPrefix = "";
  let id;
  let data = "";
  let dataLines = 0;
  let eventType;
  let terminated = false;
  let skippingLine = false;
  let skipNextLineFeed = false;
  function feed(chunk) {
    if (terminated) {
      throw new Error("Cannot feed parser: it was terminated after exceeding the configured max buffer size. Call `reset()` to resume parsing.");
    }
    if (bomPrefix !== undefined) {
      chunk = bomPrefix + chunk;
      if (chunk === "" || chunk === "\xEF" || chunk === "\xEF\xBB") {
        bomPrefix = chunk;
        return;
      }
      bomPrefix = undefined;
      chunk = chunk.replace(/^(?:\uFEFF|\xEF\xBB\xBF)/, "");
    }
    if (skippingLine || skipNextLineFeed) {
      chunk = resumeAfterSkip(chunk);
      if (!chunk) {
        return;
      }
    }
    if (!pendingFragments.length) {
      const trailing = processLines(chunk);
      if (trailing !== "") {
        storeTrailing(trailing);
      }
      checkBufferSize();
      return;
    }
    if (chunk.indexOf(`
`) === -1 && chunk.indexOf("\r") === -1) {
      if (pendingFragmentsLength < MAX_FIELD_PREFIX_LENGTH) {
        const head = pendingFragments.join("") + chunk.slice(0, MAX_FIELD_PREFIX_LENGTH - pendingFragmentsLength);
        if (!shouldBufferTrailing(head)) {
          pendingFragments.length = 0;
          pendingFragmentsLength = 0;
          skippingLine = true;
          return;
        }
      }
      pendingFragments.push(chunk);
      pendingFragmentsLength += chunk.length;
      checkBufferSize();
      return;
    }
    pendingFragments.push(chunk);
    const input = pendingFragments.join("");
    pendingFragments.length = 0;
    pendingFragmentsLength = 0;
    storeTrailing(processLines(input));
    checkBufferSize();
  }
  function resumeAfterSkip(chunk) {
    if (chunk.length === 0) {
      return chunk;
    }
    if (skipNextLineFeed) {
      skipNextLineFeed = false;
      return chunk.charCodeAt(0) === LF ? chunk.slice(1) : chunk;
    }
    const crIndex = chunk.indexOf("\r");
    const lfIndex = chunk.indexOf(`
`);
    const lineEnd = crIndex === -1 ? lfIndex : lfIndex === -1 ? crIndex : crIndex < lfIndex ? crIndex : lfIndex;
    if (lineEnd === -1) {
      return "";
    }
    if (lineEnd === chunk.length - 1 && chunk.charCodeAt(lineEnd) === CR) {
      skippingLine = false;
      skipNextLineFeed = true;
      return "";
    }
    skippingLine = false;
    return chunk.slice(lineEnd + (chunk.charCodeAt(lineEnd) === CR && chunk.charCodeAt(lineEnd + 1) === LF ? 2 : 1));
  }
  function storeTrailing(trailing) {
    if (!trailing)
      return;
    if (trailing.charCodeAt(trailing.length - 1) === CR) {
      parseLine(trailing, 0, trailing.length - 1);
      skipNextLineFeed = true;
      return;
    }
    if (shouldBufferTrailing(trailing)) {
      pendingFragments.push(trailing);
      pendingFragmentsLength = trailing.length;
      return;
    }
    skippingLine = true;
  }
  function shouldBufferTrailing(trailing) {
    const firstCharCode = trailing.charCodeAt(0);
    return firstCharCode === 58 && !!onComment || firstCharCode === 100 && isPotentialField(trailing, "data") || firstCharCode === 101 && isPotentialField(trailing, "event") || firstCharCode === 105 && isPotentialField(trailing, "id") || firstCharCode === 114 && isPotentialField(trailing, "retry");
  }
  function checkBufferSize() {
    if (maxBufferSize === undefined)
      return;
    if (pendingFragmentsLength + data.length <= maxBufferSize)
      return;
    terminated = true;
    pendingFragments.length = 0;
    pendingFragmentsLength = 0;
    id = undefined;
    data = "";
    dataLines = 0;
    eventType = undefined;
    skippingLine = false;
    skipNextLineFeed = false;
    onError === null || onError === undefined || onError(new ParseError(`Buffered data exceeded max buffer size of ${maxBufferSize} characters`, {
      type: "max-buffer-size-exceeded"
    }));
  }
  function processLines(chunk) {
    let searchIndex = 0;
    if (chunk.indexOf("\r") === -1) {
      let lfIndex = chunk.indexOf(`
`, searchIndex);
      while (lfIndex !== -1) {
        if (searchIndex === lfIndex) {
          if (id !== undefined) {
            onId === null || onId === undefined || onId(id);
          }
          if (dataLines > 0) {
            onEvent === null || onEvent === undefined || onEvent({ id, event: eventType, data });
          }
          id = undefined;
          data = "";
          dataLines = 0;
          eventType = undefined;
          searchIndex = lfIndex + 1;
          lfIndex = chunk.indexOf(`
`, searchIndex);
          continue;
        }
        const firstCharCode = chunk.charCodeAt(searchIndex);
        if (isDataPrefix(chunk, searchIndex, firstCharCode)) {
          const valueStart = chunk.charCodeAt(searchIndex + 5) === SPACE ? searchIndex + 6 : searchIndex + 5;
          const value = chunk.slice(valueStart, lfIndex);
          if (dataLines === 0 && chunk.charCodeAt(lfIndex + 1) === LF) {
            if (id !== undefined) {
              onId === null || onId === undefined || onId(id);
            }
            onEvent === null || onEvent === undefined || onEvent({ id, event: eventType, data: value });
            id = undefined;
            data = "";
            eventType = undefined;
            searchIndex = lfIndex + 2;
            lfIndex = chunk.indexOf(`
`, searchIndex);
            continue;
          }
          data = dataLines === 0 ? value : `${data}
${value}`;
          dataLines++;
        } else if (isEventPrefix(chunk, searchIndex, firstCharCode)) {
          eventType = chunk.slice(chunk.charCodeAt(searchIndex + 6) === SPACE ? searchIndex + 7 : searchIndex + 6, lfIndex) || undefined;
        } else {
          parseLine(chunk, searchIndex, lfIndex);
        }
        searchIndex = lfIndex + 1;
        lfIndex = chunk.indexOf(`
`, searchIndex);
      }
      return chunk.slice(searchIndex);
    }
    while (searchIndex < chunk.length) {
      const crIndex = chunk.indexOf("\r", searchIndex);
      const lfIndex = chunk.indexOf(`
`, searchIndex);
      let lineEnd = -1;
      if (crIndex !== -1 && lfIndex !== -1) {
        lineEnd = crIndex < lfIndex ? crIndex : lfIndex;
      } else if (crIndex !== -1) {
        if (crIndex === chunk.length - 1) {
          lineEnd = -1;
        } else {
          lineEnd = crIndex;
        }
      } else if (lfIndex !== -1) {
        lineEnd = lfIndex;
      }
      if (lineEnd === -1) {
        break;
      }
      parseLine(chunk, searchIndex, lineEnd);
      searchIndex = lineEnd + 1;
      if (chunk.charCodeAt(searchIndex - 1) === CR && chunk.charCodeAt(searchIndex) === LF) {
        searchIndex++;
      }
    }
    return chunk.slice(searchIndex);
  }
  function parseLine(chunk, start, end) {
    if (start === end) {
      dispatchEvent();
      return;
    }
    const firstCharCode = chunk.charCodeAt(start);
    if (isDataPrefix(chunk, start, firstCharCode)) {
      const valueStart = chunk.charCodeAt(start + 5) === SPACE ? start + 6 : start + 5;
      const value = chunk.slice(valueStart, end);
      data = dataLines === 0 ? value : `${data}
${value}`;
      dataLines++;
      return;
    }
    if (isEventPrefix(chunk, start, firstCharCode)) {
      eventType = chunk.slice(chunk.charCodeAt(start + 6) === SPACE ? start + 7 : start + 6, end) || undefined;
      return;
    }
    if (firstCharCode === 105 && chunk.charCodeAt(start + 1) === 100 && chunk.charCodeAt(start + 2) === 58) {
      const value = chunk.slice(chunk.charCodeAt(start + 3) === SPACE ? start + 4 : start + 3, end);
      if (!value.includes("\x00"))
        id = value;
      return;
    }
    if (firstCharCode === 58) {
      if (onComment) {
        const line = chunk.slice(start, end);
        onComment(line.slice(chunk.charCodeAt(start + 1) === SPACE ? 2 : 1));
      }
      return;
    }
    const line = chunk.slice(start, end);
    const fieldSeparatorIndex = line.indexOf(":");
    if (fieldSeparatorIndex === -1) {
      processField(line, "", line);
      return;
    }
    const field = line.slice(0, fieldSeparatorIndex);
    const offset = line.charCodeAt(fieldSeparatorIndex + 1) === SPACE ? 2 : 1;
    const value = line.slice(fieldSeparatorIndex + offset);
    processField(field, value, line);
  }
  function processField(field, value, line) {
    switch (field) {
      case "event":
        eventType = value || undefined;
        break;
      case "data":
        data = dataLines === 0 ? value : `${data}
${value}`;
        dataLines++;
        break;
      case "id":
        if (!value.includes("\x00"))
          id = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) {
          onRetry === null || onRetry === undefined || onRetry(parseInt(value, 10));
        } else {
          onError === null || onError === undefined || onError(new ParseError(`Invalid \`retry\` value: "${value}"`, {
            type: "invalid-retry",
            value,
            line
          }));
        }
        break;
      default:
        onError === null || onError === undefined || onError(new ParseError(`Unknown field "${field.length > 20 ? `${field.slice(0, 20)}\u2026` : field}"`, { type: "unknown-field", field, value, line }));
        break;
    }
  }
  function dispatchEvent() {
    if (id !== undefined) {
      onId === null || onId === undefined || onId(id);
    }
    if (dataLines > 0) {
      onEvent === null || onEvent === undefined || onEvent({
        id,
        event: eventType,
        data
      });
    }
    id = undefined;
    data = "";
    dataLines = 0;
    eventType = undefined;
  }
  function reset(options = {}) {
    if (options.consume && pendingFragments.length > 0) {
      const incompleteLine = pendingFragments.join("");
      parseLine(incompleteLine, 0, incompleteLine.length);
    }
    bomPrefix = "";
    id = undefined;
    data = "";
    dataLines = 0;
    eventType = undefined;
    pendingFragments.length = 0;
    pendingFragmentsLength = 0;
    terminated = false;
    skippingLine = false;
    skipNextLineFeed = false;
  }
  return { feed, reset };
}
function isDataPrefix(chunk, i, firstCharCode) {
  return firstCharCode === 100 && chunk.charCodeAt(i + 1) === 97 && chunk.charCodeAt(i + 2) === 116 && chunk.charCodeAt(i + 3) === 97 && chunk.charCodeAt(i + 4) === 58;
}
function isEventPrefix(chunk, i, firstCharCode) {
  return firstCharCode === 101 && chunk.charCodeAt(i + 1) === 118 && chunk.charCodeAt(i + 2) === 101 && chunk.charCodeAt(i + 3) === 110 && chunk.charCodeAt(i + 4) === 116 && chunk.charCodeAt(i + 5) === 58;
}
function isPotentialField(line, field) {
  let i = 1;
  while (i < line.length && i < field.length) {
    if (line.charCodeAt(i) !== field.charCodeAt(i)) {
      return false;
    }
    i++;
  }
  return line.length <= field.length || line.charCodeAt(field.length) === 58;
}
// src/proxy/tap.ts
var EMPTY_USAGE = {
  cost: null,
  upstreamCost: null,
  input: null,
  output: null,
  reasoning: null,
  cached: null
};
function emptyResult() {
  return {
    generation: null,
    provider: null,
    model: null,
    usage: { ...EMPTY_USAGE },
    finishReason: null,
    error: null
  };
}
function num(value) {
  return typeof value === "number" ? value : null;
}
function str(value) {
  return typeof value === "string" && value !== "" ? value : null;
}
function usageOf(value) {
  if (value === null || typeof value !== "object")
    return { ...EMPTY_USAGE };
  const usage = value;
  const details = typeof usage.cost_details === "object" && usage.cost_details !== null ? usage.cost_details : {};
  const completionDetails = typeof usage.completion_tokens_details === "object" && usage.completion_tokens_details !== null ? usage.completion_tokens_details : {};
  const promptDetails = typeof usage.prompt_tokens_details === "object" && usage.prompt_tokens_details !== null ? usage.prompt_tokens_details : {};
  return {
    cost: num(usage.cost) ?? num(usage.estimated_cost),
    upstreamCost: num(details.upstream_inference_cost),
    input: num(usage.prompt_tokens),
    output: num(usage.completion_tokens),
    reasoning: num(completionDetails.reasoning_tokens),
    cached: num(promptDetails.cached_tokens)
  };
}
var anthropicCounts = new WeakMap;
function objectOf(value) {
  return value !== null && typeof value === "object" ? value : null;
}
function mergeAnthropicUsage(state, value) {
  const usage = objectOf(value);
  if (usage === null)
    return;
  const details = objectOf(usage.cost_details) ?? {};
  const old = anthropicCounts.get(state) ?? {
    input: null,
    cacheRead: null,
    cacheCreation: null,
    output: null,
    cost: null,
    upstreamCost: null
  };
  const counts = {
    input: num(usage.input_tokens) ?? old.input,
    cacheRead: num(usage.cache_read_input_tokens) ?? old.cacheRead,
    cacheCreation: num(usage.cache_creation_input_tokens) ?? old.cacheCreation,
    output: num(usage.output_tokens) ?? old.output,
    cost: num(usage.cost) ?? old.cost,
    upstreamCost: num(details.upstream_inference_cost) ?? old.upstreamCost
  };
  anthropicCounts.set(state, counts);
  const parts = [counts.input, counts.cacheRead, counts.cacheCreation];
  state.usage = {
    cost: counts.cost,
    upstreamCost: counts.upstreamCost,
    input: parts.every((part) => part === null) ? null : parts.reduce((sum, part) => sum + (part ?? 0), 0),
    output: counts.output,
    reasoning: null,
    cached: counts.cacheRead
  };
}
function applyAnthropicMessage(state, message) {
  const generation = str(message.id);
  if (generation !== null)
    state.generation = generation;
  const model = str(message.model);
  if (model !== null)
    state.model = model;
  const provider = str(message.provider);
  if (provider !== null)
    state.provider = provider;
  const stopReason = str(message.stop_reason);
  if (stopReason !== null)
    state.finishReason = stopReason;
  if (message.usage !== undefined)
    mergeAnthropicUsage(state, message.usage);
}
function applyAnthropic(state, data) {
  switch (data.type) {
    case "message":
      applyAnthropicMessage(state, data);
      break;
    case "message_start": {
      const message = objectOf(data.message);
      if (message !== null)
        applyAnthropicMessage(state, message);
      break;
    }
    case "message_delta": {
      const stopReason = str(objectOf(data.delta)?.stop_reason);
      if (stopReason !== null)
        state.finishReason = stopReason;
      if (data.usage !== undefined)
        mergeAnthropicUsage(state, data.usage);
      break;
    }
    case "error": {
      const message = str(objectOf(data.error)?.message);
      state.error = message ?? "upstream error event";
      break;
    }
    case "message_stop":
    case "content_block_start":
    case "content_block_delta":
    case "content_block_stop":
    case "ping":
      break;
    default:
      return false;
  }
  const provider = str(data.provider);
  if (provider !== null)
    state.provider = provider;
  return true;
}
function applyChunk(state, chunk) {
  if (chunk === null || typeof chunk !== "object")
    return;
  const data = chunk;
  if (typeof data.type === "string" && applyAnthropic(state, data))
    return;
  const generation = str(data.id);
  if (generation !== null)
    state.generation = generation;
  const provider = str(data.provider);
  if (provider !== null)
    state.provider = provider;
  const model = str(data.model);
  if (model !== null)
    state.model = model;
  if (data.usage !== undefined)
    state.usage = usageOf(data.usage);
  if (Array.isArray(data.choices)) {
    const choice = data.choices[0];
    if (choice !== null && typeof choice === "object") {
      const finishReason = str(choice.finish_reason);
      if (finishReason !== null)
        state.finishReason = finishReason;
    }
  }
  if (typeof data.error === "object" && data.error !== null) {
    const message = str(data.error.message);
    if (message !== null)
      state.error = message;
  } else if (typeof data.error === "string") {
    state.error = data.error;
  }
}
function createSseTap() {
  const state = emptyResult();
  const parser = createParser({
    onEvent(event) {
      const data = event.data;
      if (data === "" || data === "[DONE]")
        return;
      try {
        applyChunk(state, JSON.parse(data));
      } catch {}
    }
  });
  return {
    push(chunk) {
      parser.feed(chunk);
    },
    result: () => state
  };
}

// src/proxy/proxy.ts
var LOG_SOURCE = "idfx-cost-proxy";
var DEFAULT_UPSTREAM = "https://openrouter.ai/api";
var DEFAULT_DEEPINFRA_UPSTREAM = "https://api.deepinfra.com";
var DEEPINFRA_PREFIX = "/deepinfra";
function routeRequest(pathname, search, upstream, deepinfraUpstream) {
  if (pathname === DEEPINFRA_PREFIX || pathname.startsWith(`${DEEPINFRA_PREFIX}/`)) {
    return { upstream: "deepinfra", target: deepinfraUpstream + pathname.slice(DEEPINFRA_PREFIX.length) + search };
  }
  return { upstream: "openrouter", target: upstream + pathname + search };
}
var decoder = new TextDecoder;
function startProxy({
  port,
  hostname = "127.0.0.1",
  upstream = DEFAULT_UPSTREAM,
  deepinfraUpstream = DEFAULT_DEEPINFRA_UPSTREAM,
  log = (line) => console.log(JSON.stringify(line)),
  fetchImpl = fetch
}) {
  let nextRequest = 1;
  const writeEnd = (state, tap, status, firstByteAt, error) => {
    log({
      source: LOG_SOURCE,
      event: "end",
      time: new Date().toISOString(),
      request: state.request,
      upstream: state.upstream,
      session: state.session,
      parentSession: state.parentSession,
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
        cached: tap.usage.cached
      },
      finishReason: tap.finishReason,
      error
    });
  };
  return Bun.serve({
    port,
    hostname,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const route = routeRequest(url.pathname, url.search, upstream, deepinfraUpstream);
      const state = {
        request: nextRequest++,
        upstream: route.upstream,
        session: req.headers.get("X-Session-Id"),
        parentSession: req.headers.get("x-parent-session-id"),
        method: req.method,
        path: url.pathname + url.search,
        startedAt: performance.now()
      };
      log({
        source: LOG_SOURCE,
        event: "start",
        time: new Date().toISOString(),
        request: state.request,
        upstream: state.upstream,
        session: state.session,
        parentSession: state.parentSession,
        method: state.method,
        path: state.path
      });
      const headers = new Headers(req.headers);
      headers.delete("host");
      headers.delete("accept-encoding");
      let res;
      try {
        res = await fetchImpl(route.target, {
          method: req.method,
          headers,
          body: req.body,
          redirect: "manual"
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
        const tap = createSseTap();
        let firstByteAt = null;
        const reader = res.body.getReader();
        let settled = false;
        const finish = (error) => {
          if (settled)
            return;
          settled = true;
          writeEnd(state, tap.result(), status, firstByteAt, error);
        };
        const stream = new ReadableStream({
          async pull(controller) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                finish(tap.result().error);
                controller.close();
                return;
              }
              if (firstByteAt === null)
                firstByteAt = performance.now();
              tap.push(decoder.decode(value, { stream: true }));
              controller.enqueue(value);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              finish(message);
              controller.error(error);
            }
          },
          async cancel(reason) {
            finish(reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "client aborted");
            try {
              await reader.cancel();
            } catch {}
          }
        });
        return new Response(stream, { status, headers: responseHeaders });
      }
      const tap = createSseTap().result();
      let error = null;
      let firstByteAt = null;
      let text = "";
      try {
        text = await res.text();
        firstByteAt = performance.now();
        if (text !== "" && contentType.includes("json")) {
          applyChunk(tap, JSON.parse(text));
        }
        if (status >= 400)
          error = res.statusText || `HTTP ${status}`;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      writeEnd(state, tap, status, firstByteAt, error);
      return new Response(text, { status, headers: responseHeaders });
    }
  });
}

// src/proxy/main.ts
function argOf(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
var port = Number(argOf("--port") ?? "4097");
var hostname = argOf("--hostname") ?? "127.0.0.1";
var upstream = argOf("--upstream");
var deepinfraUpstream = argOf("--deepinfra-upstream");
var server = startProxy({ port, hostname, upstream, deepinfraUpstream });
console.log(JSON.stringify({
  source: LOG_SOURCE,
  event: "listening",
  time: new Date().toISOString(),
  hostname: server.hostname,
  port: server.port,
  upstream: upstream ?? DEFAULT_UPSTREAM,
  deepinfraUpstream: deepinfraUpstream ?? DEFAULT_DEEPINFRA_UPSTREAM
}));
