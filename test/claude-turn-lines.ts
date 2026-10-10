/**
 * Invented transcript lines for the turn and background task tests, in the
 * shapes of Claude Code 2.1.x. No line holds real content.
 */
const at = (second: number): string => new Date(Date.parse("2026-10-06T12:00:00.000Z") + second * 1000).toISOString();

export const turnLines = {
  prompt: (second: number, text = "FAKE PROMPT"): string =>
    JSON.stringify({ type: "user", origin: { kind: "human" }, message: { role: "user", content: text }, timestamp: at(second), cwd: "/home/user/src/proj" }),
  assistant: (second: number, id = `msg_${second}`): string =>
    JSON.stringify({ type: "assistant", message: { id, model: "claude-opus-5-5", content: [{ type: "text", text: "FAKE ANSWER" }], usage: { input_tokens: 1, output_tokens: 1 } }, timestamp: at(second), cwd: "/home/user/src/proj" }),
  turnEnd: (second: number): string =>
    JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 1000, timestamp: at(second), cwd: "/home/user/src/proj" }),
  bashStart: (second: number, toolUseId: string, taskId: string): string =>
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "FAKE OUTPUT" }] },
      toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: taskId },
      timestamp: at(second),
    }),
  agentStart: (second: number, toolUseId: string, agentId: string): string =>
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text: "FAKE LAUNCH" }] }] },
      toolUseResult: { isAsync: true, status: "async_launched", agentId, description: "FAKE TASK", prompt: "FAKE BRIEF", outputFile: "/tmp/x" },
      timestamp: at(second),
    }),
  monitorStart: (second: number, toolUseId: string, taskId: string): string =>
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "FAKE MONITOR" }] },
      toolUseResult: { taskId, timeoutMs: 60000, persistent: false },
      timestamp: at(second),
    }),
  /** A task report as Claude Code queues it. With a null `status`, it is a Monitor event. */
  enqueue: (second: number, toolUseId: string, taskId: string, status: string | null = "completed"): string =>
    JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n${status === null ? "<event>FAKE EVENT</event>" : `<status>${status}</status>\n<summary>FAKE SUMMARY</summary>`}\n</task-notification>`,
      timestamp: at(second),
    }),
  /** A task report as Claude Code delivers it: the start of a new turn. */
  delivered: (second: number, toolUseId: string, taskId: string): string =>
    JSON.stringify({
      type: "user",
      origin: { kind: "task-notification", producer: "session-task" },
      message: { role: "user", content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n</task-notification>` },
      timestamp: at(second),
    }),
};

/** The time of a second of the invented transcript, in ms. */
export const turnTime = (second: number): number => Date.parse(at(second));

export const transcriptOf = (lines: readonly string[]): Uint8Array => new TextEncoder().encode(`${lines.join("\n")}\n`);
