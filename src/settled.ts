/** Decide whether a session that is missing from the status map has ended. */
import type { MessageEntry } from "./summary";

/**
 * How long a session with no finished assistant message must be quiet before
 * a missing status entry counts as idle. It covers sessions that never got a
 * prompt, and prompts that failed before any answer.
 */
export const QUIET_GRACE_MS = 10_000;

/**
 * The server lists only sessions that are not idle in `GET /session/status`.
 * A missing session is therefore either finished, or so new that the server
 * has not marked it busy yet (right after `prompt_async`). This function
 * tells the two cases apart:
 *
 * - The last message is an assistant message with a completion time: the
 *   session has ended.
 * - Otherwise the session counts as ended only when nothing happened for
 *   `graceMs` (no session update and no new message).
 */
export function missingSessionIsSettled(
  messages: readonly MessageEntry[],
  sessionUpdatedMs: number,
  nowMs: number,
  graceMs: number = QUIET_GRACE_MS,
): boolean {
  const last = messages[messages.length - 1];
  if (last !== undefined && last.info.role === "assistant" && last.info.time.completed !== undefined) {
    return true;
  }
  let lastActivity = sessionUpdatedMs;
  if (last !== undefined) lastActivity = Math.max(lastActivity, last.info.time.created);
  return nowMs - lastActivity >= graceMs;
}
