/**
 * The incremental reader of a Claude Code transcript
 * (`~/.claude/projects/<dir>/<sessionId>.jsonl`). It is pure over byte
 * buffers: the caller reads the new bytes of the file and feeds them in, so
 * the tests need no files. An incomplete last line waits for the next feed.
 *
 * The reader parses only the line types that it needs: `assistant`,
 * `system`, `custom-title`, `ai-title`, `agent-name`, and `queue-operation`.
 * It parses a `user` line only when a quick text test finds the start of a
 * background task or the start of a turn in it, and then it keeps only IDs
 * and the time. It never parses a `last-prompt` line, so prompts stay out
 * of its state. Of an `api_error` line it keeps only the error text, cut to
 * `API_ERROR_TEXT_LENGTH` characters, and the time.
 *
 * The turn and the background tasks (Claude Code 2.1.x):
 * - A turn ends with a `system` line with subtype `turn_duration`.
 * - A new turn starts with a `user` line whose `origin.kind` is `human` (a
 *   prompt) or `task-notification` (a delivered task report), or with a real
 *   `assistant` line.
 * - A background task starts with a `user` tool result line whose
 *   `toolUseResult` has a `backgroundTaskId` (Bash), the status
 *   `async_launched` (Agent), or a `taskId` and `persistent` (Monitor).
 * - A background task ends with a `<task-notification>` text that has a
 *   `<status>` tag, in a `queue-operation` enqueue line or a `user` line.
 *   The text names the task by `<tool-use-id>` and `<task-id>`. A Monitor
 *   event has no `<status>` tag and does not end its task.
 */

/** The longest error text that the reader keeps of an `api_error` line. */
export const API_ERROR_TEXT_LENGTH = 200;

/** The tokens of one model. */
export type TokenCounts = {
  input: number;
  output: number;
  /** Thinking tokens, a part of `output`. */
  thinking: number;
  cacheRead: number;
  /** Cache write tokens with the 5-minute lifetime (or without a split). */
  cacheWrite5m: number;
  /** Cache write tokens with the 1-hour lifetime. */
  cacheWrite1h: number;
};

/** The summary of one transcript so far. */
export type TranscriptSummary = {
  /** The model of the last real assistant line. */
  model: string | undefined;
  /** The tokens per model, one usage per `message.id`. */
  usageByModel: Map<string, TokenCounts>;
  /** Input plus cache read plus cache write tokens of the last request. */
  contextTokens: number;
  /** Thinking tokens of the last request. */
  lastThinking: number;
  /** The count of distinct `message.id` values. */
  steps: number;
  /** The count of distinct `tool_use` blocks. */
  toolCalls: number;
  /** The `timestamp` of the first and of the last parsed line, in ms. */
  firstActivityMs: number | undefined;
  lastActivityMs: number | undefined;
  /** The last `custom-title`, the last `ai-title`, and the last `agent-name`. */
  customTitle: string | undefined;
  aiTitle: string | undefined;
  agentName: string | undefined;
  /** The `cwd` of the last parsed line that has one. */
  cwd: string | undefined;
  /** The count of `system` lines with subtype `api_error`. */
  apiErrors: number;
  /** The error text of the last `api_error` line, cut to `API_ERROR_TEXT_LENGTH` characters. */
  lastApiErrorText: string | undefined;
  /** The `timestamp` of the last `api_error` line, in ms. */
  lastApiErrorMs: number | undefined;
  /** Whether the last turn ended (a `turn_duration` line) and no new turn started after it. */
  turnEnded: boolean;
  /** The `timestamp` of the last `turn_duration` line, in ms. */
  turnEndedMs: number | undefined;
  /** The count of background tasks that started and have no final `task-notification` yet. */
  backgroundTasks: number;
};

export type TranscriptReader = {
  /** Feed the next bytes of the file. */
  feed(bytes: Uint8Array): void;
  /** The summary of all complete lines so far. */
  summary(): TranscriptSummary;
  /** The count of bytes fed so far, the offset of the next read. */
  offset(): number;
};

/** The line types that the reader parses. A quick text test skips every other line before JSON.parse. */
const WANTED = /"type":"(assistant|system|custom-title|ai-title|agent-name|queue-operation)"/;

const WANTED_TYPES = new Set(["assistant", "system", "custom-title", "ai-title", "agent-name", "queue-operation", "user"]);

/** A `user` line is parsed only when this text test finds a task start, a task report, or a turn start in it. */
const USER_WANTED = /"type":"user"/;
const USER_MARKERS = /"backgroundTaskId"|"async_launched"|"persistent"|"kind":"(human|task-notification)"/;

/** The start of a task report text. */
const NOTIFICATION = "<task-notification>";

/** The model id of the lines that Claude Code writes itself, for example for an API error. */
const SYNTHETIC_MODEL = "<synthetic>";

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
  output_tokens_details?: { thinking_tokens?: number } | null;
};

type Line = {
  type?: string;
  subtype?: string;
  timestamp?: string;
  cwd?: string;
  customTitle?: string;
  aiTitle?: string;
  agentName?: string;
  error?: unknown;
  operation?: string;
  content?: unknown;
  origin?: { kind?: unknown } | null;
  toolUseResult?: unknown;
  message?: {
    id?: string;
    model?: string;
    usage?: Usage;
    content?: Array<{ type?: string; id?: string; tool_use_id?: string }> | string;
  };
};

const num = (value: number | undefined): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** The token counts of one `message.usage`. */
export function tokensOf(usage: Usage): TokenCounts {
  const cacheWrite = num(usage.cache_creation_input_tokens);
  const oneHour = num(usage.cache_creation?.ephemeral_1h_input_tokens);
  return {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    thinking: num(usage.output_tokens_details?.thinking_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    // Without a split, all cache writes count at the 5-minute price.
    cacheWrite5m: Math.max(0, cacheWrite - oneHour),
    cacheWrite1h: Math.min(oneHour, cacheWrite),
  };
}

export function emptyTokens(): TokenCounts {
  return { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

export function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    thinking: a.thinking + b.thinking,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
  };
}

/** The tokens of all models together. */
export function totalTokens(usageByModel: ReadonlyMap<string, TokenCounts>): TokenCounts {
  let total = emptyTokens();
  for (const tokens of usageByModel.values()) total = addTokens(total, tokens);
  return total;
}

/** Add the usage of `from` into `into`, per model. */
export function mergeUsage(into: Map<string, TokenCounts>, from: ReadonlyMap<string, TokenCounts>): void {
  for (const [model, tokens] of from) into.set(model, addTokens(into.get(model) ?? emptyTokens(), tokens));
}

/**
 * The text of the `error` field of an `api_error` line: `formatted`, else
 * `message`, else a plain string, cut to `API_ERROR_TEXT_LENGTH` characters.
 */
export function apiErrorText(error: unknown): string | undefined {
  let text: string | undefined;
  if (typeof error === "string") text = error;
  else if (error !== null && typeof error === "object") {
    const record = error as { formatted?: unknown; message?: unknown };
    if (typeof record.formatted === "string") text = record.formatted;
    else if (typeof record.message === "string") text = record.message;
  }
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, API_ERROR_TEXT_LENGTH);
}

/** The IDs of a background task: the ID of its tool call and its task ID. */
export type TaskIds = { toolUseId: string | undefined; taskId: string | undefined };

/**
 * The IDs of the background task that a `user` tool result line starts, or
 * undefined when the line starts none. Bash gives `backgroundTaskId`, Agent
 * gives the status `async_launched` with an `agentId`, and Monitor gives a
 * `taskId` with `persistent`.
 */
export function taskStartOf(line: Pick<Line, "toolUseResult" | "message">): TaskIds | undefined {
  const result = line.toolUseResult;
  if (result === null || typeof result !== "object") return undefined;
  const r = result as { backgroundTaskId?: unknown; status?: unknown; agentId?: unknown; taskId?: unknown; persistent?: unknown };
  let taskId: string | undefined;
  if (typeof r.backgroundTaskId === "string") taskId = r.backgroundTaskId;
  else if (r.status === "async_launched" && typeof r.agentId === "string") taskId = r.agentId;
  else if (typeof r.taskId === "string" && typeof r.persistent === "boolean") taskId = r.taskId;
  else return undefined;
  const content = line.message?.content;
  const block = Array.isArray(content) ? content.find((b) => b?.type === "tool_result") : undefined;
  const toolUseId = typeof block?.tool_use_id === "string" ? block.tool_use_id : undefined;
  return { toolUseId, taskId };
}

const tag = (text: string, name: string): string | undefined => {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(text);
  const value = match?.[1]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
};

/**
 * The IDs of the task that a `<task-notification>` text ends, or undefined
 * when the text ends no task: it is no report, or it has no `<status>` tag
 * (a Monitor event).
 */
export function taskEndOf(text: string): TaskIds | undefined {
  if (!text.includes(NOTIFICATION)) return undefined;
  if (tag(text, "status") === undefined) return undefined;
  const ids = { toolUseId: tag(text, "tool-use-id"), taskId: tag(text, "task-id") };
  return ids.toolUseId === undefined && ids.taskId === undefined ? undefined : ids;
}

export function createTranscriptReader(): TranscriptReader {
  const decoder = new TextDecoder();
  let rest = "";
  let bytes = 0;
  // One usage per message id: a response spans several lines, and each line
  // repeats the usage. The last line of a message wins.
  const messages = new Map<string, { model: string; tokens: TokenCounts }>();
  const toolUseIds = new Set<string>();
  let anonymousToolUses = 0;
  // The running background tasks, and the IDs of the tasks that ended. An
  // ID that ended before its start line (never seen so far) does not start.
  const running: TaskIds[] = [];
  const ended = new Set<string>();
  const sameTask = (a: TaskIds, b: TaskIds): boolean =>
    (a.toolUseId !== undefined && a.toolUseId === b.toolUseId) || (a.taskId !== undefined && a.taskId === b.taskId);
  const startTask = (ids: TaskIds): void => {
    if ((ids.toolUseId !== undefined && ended.has(ids.toolUseId)) || (ids.taskId !== undefined && ended.has(ids.taskId))) return;
    if (running.some((task) => sameTask(task, ids))) return;
    running.push(ids);
  };
  const endTask = (ids: TaskIds): void => {
    if (ids.toolUseId !== undefined) ended.add(ids.toolUseId);
    if (ids.taskId !== undefined) ended.add(ids.taskId);
    for (let i = running.length - 1; i >= 0; i--) if (sameTask(running[i] as TaskIds, ids)) running.splice(i, 1);
  };
  const state = {
    model: undefined as string | undefined,
    contextTokens: 0,
    lastThinking: 0,
    firstActivityMs: undefined as number | undefined,
    lastActivityMs: undefined as number | undefined,
    customTitle: undefined as string | undefined,
    aiTitle: undefined as string | undefined,
    agentName: undefined as string | undefined,
    cwd: undefined as string | undefined,
    apiErrors: 0,
    lastApiErrorText: undefined as string | undefined,
    lastApiErrorMs: undefined as number | undefined,
    turnEnded: false,
    turnEndedMs: undefined as number | undefined,
  };

  const handle = (line: Line): void => {
    // The text test can match a nested object of another line type, so the
    // top-level type decides.
    if (line.type === undefined || !WANTED_TYPES.has(line.type)) return;
    // Only the old line types give the activity times and the folder, so the
    // turn and task lines below change no other field.
    const activity = line.type !== "user" && line.type !== "queue-operation";
    if (activity && typeof line.timestamp === "string") {
      const ms = Date.parse(line.timestamp);
      if (Number.isFinite(ms)) {
        state.firstActivityMs ??= ms;
        state.lastActivityMs = ms;
      }
    }
    if (activity && typeof line.cwd === "string") state.cwd = line.cwd;
    switch (line.type) {
      case "custom-title":
        if (typeof line.customTitle === "string") state.customTitle = line.customTitle;
        return;
      case "ai-title":
        if (typeof line.aiTitle === "string") state.aiTitle = line.aiTitle;
        return;
      case "agent-name":
        if (typeof line.agentName === "string") state.agentName = line.agentName;
        return;
      case "queue-operation":
        if (line.operation === "enqueue" && typeof line.content === "string") {
          const ids = taskEndOf(line.content);
          if (ids !== undefined) endTask(ids);
        }
        return;
      case "user": {
        const kind = line.origin?.kind;
        if (kind === "human" || kind === "task-notification") state.turnEnded = false;
        const content = line.message?.content;
        if (kind === "task-notification" && typeof content === "string") {
          const ids = taskEndOf(content);
          if (ids !== undefined) endTask(ids);
        }
        const start = taskStartOf(line);
        if (start !== undefined) startTask(start);
        return;
      }
      case "system":
        if (line.subtype === "turn_duration") {
          state.turnEnded = true;
          const ms = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : Number.NaN;
          state.turnEndedMs = Number.isFinite(ms) ? ms : state.lastActivityMs;
        }
        if (line.subtype === "api_error") {
          state.apiErrors += 1;
          state.lastApiErrorText = apiErrorText(line.error);
          const ms = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : Number.NaN;
          state.lastApiErrorMs = Number.isFinite(ms) ? ms : state.lastActivityMs;
        }
        return;
      case "assistant": {
        const message = line.message;
        if (message === undefined) return;
        const model = message.model;
        if (model === undefined || model === SYNTHETIC_MODEL) return;
        state.model = model;
        state.turnEnded = false;
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block?.type !== "tool_use") continue;
            if (typeof block.id === "string") toolUseIds.add(block.id);
            else anonymousToolUses += 1;
          }
        }
        if (message.usage !== undefined && typeof message.id === "string") {
          const tokens = tokensOf(message.usage);
          messages.set(message.id, { model, tokens });
          state.contextTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h;
          state.lastThinking = tokens.thinking;
        }
        return;
      }
      default:
        return;
    }
  };

  const parseLine = (text: string): void => {
    if (!WANTED.test(text) && !(USER_WANTED.test(text) && USER_MARKERS.test(text))) return;
    let line: Line;
    try {
      line = JSON.parse(text) as Line;
    } catch {
      return;
    }
    if (line === null || typeof line !== "object") return;
    handle(line);
  };

  return {
    feed(chunk) {
      bytes += chunk.byteLength;
      const text = rest + decoder.decode(chunk, { stream: true });
      const lines = text.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length > 0) parseLine(line);
      }
    },
    summary() {
      const usageByModel = new Map<string, TokenCounts>();
      for (const { model, tokens } of messages.values()) {
        usageByModel.set(model, addTokens(usageByModel.get(model) ?? emptyTokens(), tokens));
      }
      return {
        ...state,
        usageByModel,
        steps: messages.size,
        toolCalls: toolUseIds.size + anonymousToolUses,
        backgroundTasks: running.length,
      };
    },
    offset: () => bytes,
  };
}

/** Read a whole transcript from one buffer. */
export function summarizeTranscript(bytes: Uint8Array): TranscriptSummary {
  const reader = createTranscriptReader();
  reader.feed(bytes);
  return reader.summary();
}
