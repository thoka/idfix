# Server lifecycle: up, down, restart

Date: 2026-09-28. opencode 1.18.32, `@opencode-ai/sdk` 1.18.32.

## Question

How does `oc-sub` stop the opencode server that `oc-sub up` started, now that `oc-sub` is a global command?

## Findings

- The SDK 1.18.32 has no route to shut down the server. The only related route is `POST /instance/dispose`, which disposes the instance of one folder, not the process. So `down` stops the process with a signal.
- `opencode serve` stops cleanly on SIGTERM. The integration test showed this before this step.
- One server serves many project folders. Each request names its folder with the query parameter `directory`. So the state of a server belongs to the port, not to the folder where `up` ran.
- `GET /session/status` lists only the sessions that are not idle, and only for the folder of the request. The server has no route that lists the busy sessions of all folders.
- The server creates an instance for each folder that a request names, and the instance loads the configuration of that folder. This step did not measure the cost of that load. A loop over all known projects (`GET /project`) can load many old folders and start their plugins or MCP servers, so `down` avoids it.
- A PID file can go stale. After a reboot, the PID can belong to another process.

## Decisions

- The state of a server lives in `$XDG_STATE_HOME/oc-sub/` (default `~/.local/state/oc-sub/`), as the XDG Base Directory specification defines for state data. The files are `serve-<port>.pid`, `serve-<port>.log`, and `serve-<port>.dirs`.
- `oc-sub run` appends its folder to `serve-<port>.dirs`. `oc-sub down` checks only these folders for busy sessions. They are already loaded, so the check is cheap. When `oc-sub up` starts a new server, it clears the list.
- `down` reads the command line of the PID with `ps -o args= -p PID` and signals only a process that is `opencode serve` on the same port.
- `down` sends SIGTERM to the process group (`kill(-pid)`). `up` starts the server detached, so the server leads its own group, and its child processes stop, too.
- `restart` is `down` followed by `up`. No own logic.

## Limits

- `down` does not see a busy session that was started outside `oc-sub run`, for example in the opencode interface.
- The integration test covers `restart` and `down` on a real server. It does not cover the refusal for a busy session, because that needs a model call, which costs money.
