/**
 * The wake-up of the supervisor by `idfx watch --all`. Design:
 * docs/design/idfx-watch.md, section 5.
 *
 * Each notice costs context in the supervisor, so the watcher sends few:
 *
 * - Only a True edge of a condition in `NOTIFY_CONDITIONS` gives a notice.
 *   All other edges, and all False edges, go only to the log.
 * - One poll gives at most one notice, with all its notifying edges.
 * - At most one notice goes out in `NOTICE_PAUSE_MS`. Edges that come in the
 *   pause wait and go out with the next notice.
 * - A known state never gives a second notice: a condition that stays True
 *   gives no edge, and a restart restores the state from the log.
 * - The first poll of a new log (no event at start) is the baseline. Its
 *   edges go to the log, but give no notice.
 *
 * The notice goes out through `notify-session --name supervisor` of meta. The
 * log is the record; the notice is only a wake-up. A failed notice gives a
 * warning on stderr, and the watcher goes on. Its edges are dropped, because
 * the log holds them.
 */
import { spawnSync } from "node:child_process";
import type { ConditionType, Edge } from "./conditions";

/** The conditions whose True edge wakes the supervisor. */
export const NOTIFY_CONDITIONS: ReadonlySet<ConditionType> = new Set<ConditionType>(["SessionWaitsForUser", "ApiError"]);

/** The shortest time between two notices. */
export const NOTICE_PAUSE_MS = 60_000;

/** The count of events that a notice names one by one. */
export const NOTICE_NAMED = 3;

/** The name of the session that gets the notices. */
export const SUPERVISOR_NAME = "supervisor";

/** The longest time that `notify-session` may run. */
export const NOTIFY_TIMEOUT_MS = 15_000;

/** The result of one notice: delivered, the tool is missing, or it failed with a short reason. */
export type NotifyResult = { ok: true } | { ok: false; missing: boolean; message: string };

/** Sends one notice text to the supervisor. */
export type Notifier = (text: string) => NotifyResult;

/** Whether an edge wakes the supervisor. */
export function notifies(edge: Pick<Edge, "condition" | "status">): boolean {
  return edge.status === "True" && NOTIFY_CONDITIONS.has(edge.condition);
}

/** One edge in short form, for example `meta waits for user (PermissionDialog)`. */
export function shortEdge(edge: Pick<Edge, "condition" | "subject" | "reason">): string {
  switch (edge.condition) {
    case "SessionWaitsForUser":
      return `${edge.subject} waits for user (${edge.reason})`;
    case "ApiError":
      return `${edge.subject} API error (${edge.reason})`;
    default:
      return `${edge.subject} ${edge.condition} (${edge.reason})`;
  }
}

/**
 * The notice text: the count, the first three edges in short form, and the
 * path of the log. For example
 * `idfx watch: 2 events: meta waits for user (PermissionDialog), grata API error (UsageLimit). Log: /home/u/.local/state/idfx/events.jsonl`.
 */
export function noticeText(edges: readonly Edge[], logFile: string): string {
  const named = edges.slice(0, NOTICE_NAMED).map(shortEdge);
  const more = edges.length > NOTICE_NAMED ? `, and ${edges.length - NOTICE_NAMED} more` : "";
  const noun = edges.length === 1 ? "event" : "events";
  return `idfx watch: ${edges.length} ${noun}: ${named.join(", ")}${more}. Log: ${logFile}`;
}

/** The waking part of the poll loop. It keeps the edges that wait for the pause. */
export type Waker = {
  /** Takes the edges of one poll and sends at most one notice. `baseline` marks the first poll of a new log. */
  afterPoll(edges: readonly Edge[], nowMs: number, baseline: boolean): void;
};

export function createWaker(notify: Notifier, logFile: string, stderr: (line: string) => void): Waker {
  let pending: Edge[] = [];
  let lastNoticeMs: number | undefined;
  let missingWarned = false;
  return {
    afterPoll(edges, nowMs, baseline) {
      if (!baseline) pending.push(...edges.filter(notifies));
      if (pending.length === 0) return;
      if (lastNoticeMs !== undefined && nowMs - lastNoticeMs < NOTICE_PAUSE_MS) return;
      const text = noticeText(pending, logFile);
      pending = [];
      lastNoticeMs = nowMs;
      const result = notify(text);
      if (result.ok) return;
      if (result.missing) {
        if (!missingWarned) stderr(`idfx watch: ${result.message}; the supervisor gets no wake-up`);
        missingWarned = true;
        return;
      }
      stderr(`idfx watch: the wake-up failed: ${result.message}`);
    },
  };
}

/**
 * The real notifier: `notify-session --name supervisor none <text>` from the
 * PATH. `notify-session` needs a session ID first; `none` matches no session,
 * so the name decides.
 */
export function nodeNotifier(env: Record<string, string | undefined> = process.env): Notifier {
  return (text) => {
    const bin = Bun.which("notify-session", { PATH: env.PATH ?? "" });
    if (bin === null) return { ok: false, missing: true, message: "notify-session is not on the PATH" };
    const result = spawnSync(bin, ["--name", SUPERVISOR_NAME, "--", "none", text], {
      encoding: "utf8",
      timeout: NOTIFY_TIMEOUT_MS,
      env: env as NodeJS.ProcessEnv,
    });
    if (result.error !== undefined) return { ok: false, missing: false, message: result.error.message };
    if (result.status === 0) return { ok: true };
    const reason = (result.stderr ?? "").trim().split("\n").at(-1) ?? "";
    return { ok: false, missing: false, message: `notify-session exited with code ${result.status}${reason ? `: ${reason}` : ""}` };
  };
}
