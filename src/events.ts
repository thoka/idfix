/** Filter server events for one session and turn them into short lines. */
import type { Event, Part, ToolState } from "@opencode-ai/sdk";

/** Where a string main argument lives, per tool. Falls back to the first string. */
const TOOL_MAIN_ARG: Record<string, string[]> = {
  bash: ["command"],
  read: ["filePath"],
  edit: ["filePath"],
  write: ["filePath"],
  glob: ["pattern"],
  grep: ["pattern"],
  list: ["path"],
  webfetch: ["url"],
  task: ["description", "prompt", "agent"],
};

const TOOL_LINE_MAX = 120;
const TEXT_LINE_MAX = 500;

export function toolMainArg(tool: string, input: Record<string, unknown>): string {
  for (const key of TOOL_MAIN_ARG[tool] ?? []) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return "";
}

/** Collapse whitespace and shorten to one line. */
export function shorten(text: string, max = TOOL_LINE_MAX): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 3)}...`;
}

function sessionErrorMessage(error: { data?: { message?: unknown } } | undefined): string {
  const message = error?.data?.message;
  return typeof message === "string" && message.length > 0 ? message : "unknown error";
}

/** The session ID carried by an event, if any (directly, via info, or via part). */
export function eventSessionId(event: Event): string | undefined {
  const properties = event.properties as Record<string, unknown>;
  if (typeof properties.sessionID === "string") return properties.sessionID;
  for (const key of ["info", "part"] as const) {
    const nested = properties[key];
    if (typeof nested === "object" && nested !== null) {
      const sessionID = (nested as Record<string, unknown>).sessionID;
      if (typeof sessionID === "string") return sessionID;
    }
  }
  return undefined;
}

/** Whether an event belongs to a session. session.error may omit the ID. */
export function belongsToSession(event: Event, sessionId: string): boolean {
  if (event.type === "session.error") {
    const sessionID = (event.properties as Record<string, unknown>).sessionID;
    return sessionID === undefined || sessionID === sessionId;
  }
  return eventSessionId(event) === sessionId;
}

export type WatchLine = {
  kind: "tool" | "tool-failed" | "text" | "error";
  line: string;
};

function toolPartLine(part: Extract<Part, { type: "tool" }>, seen: Set<string>): WatchLine | null {
  const state: ToolState = part.state;
  if (state.status === "error") {
    const key = `failed:${part.callID}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return { kind: "tool-failed", line: `tool ${part.tool} failed: ${shorten(state.error, 200)}` };
  }
  if (seen.has(part.callID)) return null;
  if (state.status === "pending" || state.status === "running" || state.status === "completed") {
    seen.add(part.callID);
    return { kind: "tool", line: `tool ${part.tool}: ${shorten(toolMainArg(part.tool, state.input))}` };
  }
  return null;
}

/**
 * One short line for a session event, or null when the event is not worth a
 * line. Lines are produced for: a tool call (at its first state), a tool
 * failure, and a finished assistant text. `seen` deduplicates across the
 * stream; pass one set per watch run.
 */
export function watchEventLine(event: Event, seen: Set<string>): WatchLine | null {
  switch (event.type) {
    case "message.part.updated": {
      const part = event.properties.part;
      if (part.type === "tool") return toolPartLine(part, seen);
      if (part.type === "text") {
        if (part.time?.end === undefined) return null; // still streaming
        if (part.synthetic === true || part.ignored === true) return null;
        if (seen.has(part.id)) return null;
        seen.add(part.id);
        if (part.text.trim().length === 0) return null;
        return { kind: "text", line: `assistant: ${shorten(part.text, TEXT_LINE_MAX)}` };
      }
      return null;
    }
    case "session.error":
      return {
        kind: "error",
        line: `session error: ${shorten(sessionErrorMessage(event.properties.error), 200)}`,
      };
    default:
      return null;
  }
}
