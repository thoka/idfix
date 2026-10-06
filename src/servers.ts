/**
 * The list of opencode servers that `idfx` knows: the host server (or the
 * server of an explicit `--url`) and one sandbox server per project with a
 * valid state file. `idfx status --all` and the later `idfx top` share
 * this listing.
 */
import { resolveServerUrl, type Env } from "./config";
import { readSandboxStates } from "./sandbox";

/** One known server. `project` is null for the host server. */
export type KnownServer = { project: string | null; url: string; sandbox: boolean };

/**
 * The known servers. With `urlFlag`, only that server (resolved with
 * `resolveServerUrl`, so `IDFX_URL` would not win over it). Without it,
 * the host server first (`resolveServerUrl(undefined, env)`, so
 * `IDFX_URL` still applies), then one entry per valid sandbox state file,
 * sorted by project name. A missing state folder and a missing, unreadable,
 * or invalid state file add nothing. A sandbox URL that equals the host URL
 * appears once.
 */
export function listServers(env: Env, urlFlag?: string): KnownServer[] {
  const hostUrl = resolveServerUrl(urlFlag, env);
  if (urlFlag !== undefined) return [{ project: null, url: hostUrl, sandbox: false }];
  const servers: KnownServer[] = [{ project: null, url: hostUrl, sandbox: false }];
  for (const { project, state } of readSandboxStates(env)) {
    const url = `http://127.0.0.1:${state.port}`;
    if (servers.some((server) => server.url === url)) continue;
    servers.push({ project, url, sandbox: true });
  }
  return servers;
}
