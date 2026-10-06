/**
 * The incremental reader of a Claude Code transcript
 * (`~/.claude/projects/<dir>/<sessionId>.jsonl`). It is pure over byte
 * buffers: the caller reads the new bytes of the file and feeds them in, so
 * the tests need no files. An incomplete last line waits for the next feed.
 *
 * The reader parses only the line types that it needs: `assistant`,
 * `system`, `custom-title`, `ai-title`, and `agent-name`. It never parses a
 * `user` line or a `last-prompt` line, so prompts stay out of its state.
 */

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
const WANTED = /"type":"(assistant|system|custom-title|ai-title|agent-name)"/;

const WANTED_TYPES = new Set(["assistant", "system", "custom-title", "ai-title", "agent-name"]);

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
  message?: {
    id?: string;
    model?: string;
    usage?: Usage;
    content?: Array<{ type?: string; id?: string }> | string;
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

export function createTranscriptReader(): TranscriptReader {
  const decoder = new TextDecoder();
  let rest = "";
  let bytes = 0;
  // One usage per message id: a response spans several lines, and each line
  // repeats the usage. The last line of a message wins.
  const messages = new Map<string, { model: string; tokens: TokenCounts }>();
  const toolUseIds = new Set<string>();
  let anonymousToolUses = 0;
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
  };

  const handle = (line: Line): void => {
    // The text test can match a nested object of another line type, so the
    // top-level type decides.
    if (line.type === undefined || !WANTED_TYPES.has(line.type)) return;
    if (typeof line.timestamp === "string") {
      const ms = Date.parse(line.timestamp);
      if (Number.isFinite(ms)) {
        state.firstActivityMs ??= ms;
        state.lastActivityMs = ms;
      }
    }
    if (typeof line.cwd === "string") state.cwd = line.cwd;
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
      case "system":
        if (line.subtype === "api_error") state.apiErrors += 1;
        return;
      case "assistant": {
        const message = line.message;
        if (message === undefined) return;
        const model = message.model;
        if (model === undefined || model === SYNTHETIC_MODEL) return;
        state.model = model;
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
    if (!WANTED.test(text)) return;
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
