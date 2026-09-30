/**
 * The live event stream of `oc-sub top`: it loads the start data of every
 * known server (the seed of step 8d) and then follows one
 * `GET /global/event` subscription per server. No Ink here; the Ink view of
 * step 8f renders the model that this module keeps up to date.
 *
 * Data flow. At the start, every server that answers is seeded with
 * `seedServer` from `src/top/load.ts`, and one SSE subscription opens. The
 * wire format is one `data: <json>` line per event:
 *
 *     data: {"directory":"<dir>","payload":{"id":"evt_...","type":"session.created","properties":{...}}}
 *
 * Each item is a `GlobalEvent` `{ directory, payload }` where `payload` is
 * the v1 `Event` of the SDK. Every item goes into
 * `model.apply(server.url, item.directory, item.payload, nowMs)`, except
 * items whose directory is outside the scope of `top` (the same scope as
 * `loadTop`: with `--all` every directory, else `--dir` and its git
 * worktrees) and items without a directory (for example `server.connected`).
 * The duplicate `type: "sync"` items of the v2 bridge are skipped; the plain
 * v1 event with the same data always precedes them. A timer calls
 * `model.tick` every 2 seconds; both events and ticks notify the change
 * listeners, which is what the view will re-render on.
 *
 * Reconnect. A stream that fails marks its server as `reconnecting` (via
 * `onSseError`), while the SDK retries in place with an exponential backoff
 * (`sseDefaultRetryDelay` 1 s, doubling up to `sseMaxRetryDelay` 30 s). A
 * stream that ends cleanly (the generator finishes) retries with the same
 * growing delay in this module: it waits, probes the server, seeds it again
 * (events can be lost in the gap), and opens a new stream. A mid-stream
 * error that the SDK heals itself reseeds on the first event after the
 * error. A server that was down at the start (or disappeared) is probed
 * again every 30 seconds together with a fresh `listServers` call, so that
 * a new sandbox appears; when it answers, it is seeded and its stream
 * opens.
 */
import type { GlobalEvent } from "@opencode-ai/sdk";
import { assertUsable, errorMessage, makeClient, probeServer } from "../client";
import type { Env } from "../config";
import { listServers, type KnownServer } from "../servers";
import type { StatusDeps } from "../status";
import { defaultDeps, scopeDirectories, seedServer } from "./load";
import { createTopModel, type TopModel } from "./model";

/** The tick of the stall check and the change notification. */
const TICK_MS = 2000;
/** How often the down servers and the server list are probed again. */
const PROBE_MS = 30_000;
/** First reconnect delay; the SDK and this module double it up to this cap. */
const RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30_000;

/** The clock and the timers, injected so that the tests need no real time. */
export type LiveDeps = {
  nowMs(): number;
  /** Wait for the reconnect backoff. */
  sleep(ms: number): Promise<void>;
  /** Start a repeating timer; returns a handle for `stopTimer`. */
  startTimer(handler: () => void, ms: number): unknown;
  stopTimer(handle: unknown): void;
};

const realDeps: LiveDeps = {
  nowMs: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  startTimer: (handler, ms) => {
    const timer = setInterval(handler, ms);
    timer.unref();
    return timer;
  },
  stopTimer: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** The state of one server in the live view. */
export type LiveServerState = "up" | "down" | "reconnecting";

/** One known server with its state, as `servers()` reports it. */
export type LiveServer = KnownServer & { state: LiveServerState };

type ServerEntry = {
  server: KnownServer;
  state: LiveServerState;
  controller: AbortController | undefined;
  /** Scope directories when `--dir` narrows the view; undefined with `--all`. */
  scope: Set<string> | undefined;
};

export type LiveHandle = {
  model: TopModel;
  /** The listener runs after each applied event and after each tick. */
  onChange(listener: () => void): void;
  /** Every known server with its state. */
  servers(): LiveServer[];
  /** Close all streams and timers. */
  stop(): void;
};

export async function startLive(
  args: { url?: string; dir?: string; all: boolean },
  env: Env = process.env,
  deps: StatusDeps = defaultDeps,
  live: LiveDeps = realDeps,
): Promise<LiveHandle> {
  const model = createTopModel();
  const listeners: Array<() => void> = [];
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const entries = new Map<string, ServerEntry>();
  let stopped = false;

  const directoriesOf = scopeDirectories(args, env, deps);

  /** Seed one server and open its event stream. */
  const openServer = async (entry: ServerEntry): Promise<void> => {
    const url = entry.server.url;
    const nowMs = live.nowMs();
    try {
      await seedServer(model, url, await directoriesOf(url), env, nowMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : errorMessage(error);
      console.error(`warning: ${url}: ${message}`);
    }
    runStream(entry);
  };

  /**
   * One stream per server. The SDK retries fetch failures itself with the
   * backoff options; this loop handles a stream that ends cleanly: it waits
   * with a growing delay, probes the server, seeds it again (events can be
   * lost in the gap), and opens a new stream. A stream error in the middle
   * (via `onSseError`) is retried by the SDK in place; the first event of
   * the reconnected stream triggers a reseed there.
   */
  const runStream = (entry: ServerEntry): void => {
    const url = entry.server.url;
    const controller = new AbortController();
    entry.controller = controller;
    void (async () => {
      let backoff = RETRY_DELAY_MS;
      let needsReconnect = false;
      while (!stopped) {
        if (needsReconnect) {
          entry.state = "reconnecting";
          await live.sleep(backoff);
          backoff = Math.min(backoff * 2, MAX_RETRY_DELAY_MS);
          if (stopped) break;
          const probe = await probeServer(url, env, 2000);
          if (probe.state !== "up") continue;
          try {
            await seedServer(model, url, await directoriesOf(url), env, live.nowMs());
          } catch (error) {
            const message = error instanceof Error ? error.message : errorMessage(error);
            console.error(`warning: ${url}: ${message}`);
          }
          if (stopped) break;
        }
        entry.state = "up";
        let needsReseed = false;
        let gotEvent = false;
        try {
          const client = makeClient(url, env);
          const subscription = await client.global.event({
            signal: controller.signal,
            onSseError: () => {
              // The SDK retries internally; mark the gap for a reseed.
              needsReseed = true;
              if (entry.state === "up") entry.state = "reconnecting";
            },
            sseDefaultRetryDelay: RETRY_DELAY_MS,
            sseMaxRetryDelay: MAX_RETRY_DELAY_MS,
          });
          const iterator = subscription.stream[Symbol.asyncIterator]();
          for (;;) {
            const next = await iterator.next();
            if (next.done || stopped) break;
            const item = next.value as GlobalEvent;
            if (!gotEvent) {
              gotEvent = true;
              backoff = RETRY_DELAY_MS;
            }
            if (needsReseed && gotEvent) {
              needsReseed = false;
              try {
                await seedServer(model, url, await directoriesOf(url), env, live.nowMs());
              } catch (error) {
                const message = error instanceof Error ? error.message : errorMessage(error);
                console.error(`warning: ${url}: ${message}`);
              }
            }
            applyItem(entry, item);
          }
        } catch {
          // The subscription or the iteration failed; retry with the
          // growing delay.
          needsReseed = true;
        }
        if (stopped) break;
        needsReconnect = true;
      }
    })();
  };

  /** Feed one stream item into the model, unless it is outside the scope. */
  const applyItem = (entry: ServerEntry, item: GlobalEvent): void => {
    if (stopped) return;
    // The v2 bridge duplicates every event as a `sync` item; the plain v1
    // event with the same data precedes it, so the sync copy is skipped.
    if ((item.payload as { type?: string } | undefined)?.type === "sync") return;
    if (item.directory === undefined) return;
    if (entry.scope !== undefined && !entry.scope.has(item.directory)) return;
    model.apply(entry.server.url, item.directory, item.payload, live.nowMs());
    notify();
  };

  // Start: probe and seed every known server; a down server waits for the
  // probe timer.
  for (const server of listServers(env, args.url)) {
    const scope = args.all ? undefined : new Set(await directoriesOf(server.url));
    const entry: ServerEntry = { server, state: "down", controller: undefined, scope };
    entries.set(server.url, entry);
    const probe = await probeServer(server.url, env, 2000);
    if (probe.state !== "up") {
      if (probe.state === "unauthorized") {
        try {
          assertUsable(probe, server.url, env);
        } catch (error) {
          const message = error instanceof Error ? error.message : errorMessage(error);
          console.error(`warning: ${server.url}: ${message}`);
        }
      }
      continue;
    }
    await openServer(entry);
  }

  // The tick: age the rows and re-run the stall detection. The timer
  // repeats by itself, so the handler must not start another one.
  const tickHandle = live.startTimer(() => {
    if (stopped) return;
    model.tick(live.nowMs());
    notify();
  }, TICK_MS);

  // The probe: find down servers again and discover new sandboxes.
  const probeHandle = live.startTimer(() => {
    void (async () => {
      if (stopped) return;
      for (const server of listServers(env, args.url)) {
        if (stopped) return;
        const known = entries.get(server.url);
        if (known !== undefined && known.state !== "down") continue;
        const probe = await probeServer(server.url, env, 2000);
        if (probe.state !== "up") continue;
        if (known === undefined) {
          const scope = args.all ? undefined : new Set(await directoriesOf(server.url));
          const entry: ServerEntry = { server, state: "down", controller: undefined, scope };
          entries.set(server.url, entry);
          await openServer(entry);
        } else {
          await openServer(known);
        }
      }
    })();
  }, PROBE_MS);

  return {
    model,
    onChange(listener) {
      listeners.push(listener);
    },
    servers() {
      return [...entries.values()].map(({ server, state }) => ({ ...server, state }));
    },
    stop() {
      stopped = true;
      live.stopTimer(probeHandle);
      live.stopTimer(tickHandle);
      for (const entry of entries.values()) entry.controller?.abort();
    },
  };
}
