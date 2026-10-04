---
checked: 2026-10-04
recheck: each new systemd or sbx release
decisions: ["start long-lived oc-sub processes as transient systemd user services with owner and reason (step 31)"]
---

# Process labels: owner and reason for background processes

## Problem

On 2026-10-04 a WSL2 VM held many forgotten background processes: 33 `caddy` processes, `sh -c` restart loops from oc-sub integration tests, and a 7.5 GB `oc-sub top`. Init adopted most of them, so `oc-sub doctor` finds orphans only with a guess. The question: which mechanism labels a process and its whole tree with owner and reason, so a tool sees at once which process nobody needs?

## Criteria

From the global values ("platform before own build", "one state in one place", "blast radius small") and the brief:

1. The label survives detach and double-fork of a child.
2. A tool lists all processes of one label without a guess.
3. The tool stops the whole tree with one command.
4. It works without root.
5. It works on this host: WSL2, PID 1 is `/init`, a `systemd --user` manager runs (measured by the main thread).
6. It has a clean fallback on hosts without systemd (macOS, a container, the sbx microVM).
7. A Node.js/bun library exists for it, or the effort to call it from oc-sub stays small.
8. The label carries owner and reason as data, not only a name.

## 1. Mechanisms compared

| Mechanism | Survives detach / double-fork | List by label | Stop whole tree | No root | Carries owner + reason |
|---|---|---|---|---|---|
| systemd transient service (default mode of `systemd-run`) | Yes. The manager runs the process, so the process is not a child of the caller ([systemd-run(1)](https://man7.org/linux/man-pages/man1/systemd-run.1.html), read 2026-10-04) | `systemctl --user list-units`, Description field | `systemctl --user stop` with `KillMode=control-group` | Yes (`--user`) | Yes: unit name plus `--description=`, and a custom slice name ([systemd-run(1)](https://man.archlinux.org/man/systemd-run.1.en), read 2026-10-04) |
| systemd transient scope (`--scope`) | Yes for listing (cgroup), but the process stays a child of `systemd-run`, which runs synchronously ([systemd-run(1)](https://man7.org/linux/man-pages/man1/systemd-run.1.html)) | Same as service | Same | Yes | Yes, same properties |
| Plain cgroups v2 | Yes: cgroup membership does not depend on the parent | Walk `/sys/fs/cgroup/.../cgroup.procs` | Write to `cgroup.kill` (kernel 4.19+) | Only inside a delegated subtree; needs a delegated parent cgroup ([systemd cgroup interface](https://systemd.io/CONTROL_GROUP_INTERFACE/), read 2026-10-04) | No: the name of the directory is the only label |
| Inherited environment variable, read from `/proc/<pid>/environ` | Yes: the kernel copies the environment on fork and exec, so every descendant has it | Read `/proc/<pid>/environ` for each process; no kernel index, so the tool walks all of `/proc` | No: a plain env var gives no kill handle | Yes | Yes: free-form key-value data |
| Process name (`prctl PR_SET_NAME`, argv[0]) | Forked children inherit argv[0] only if they do not rewrite it; PR_SET_NAME sets one thread name, max 16 bytes ([PR_SET_NAME(2const)](https://man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html), read 2026-10-04) | `ps -C` or scan `/proc/*/comm` | No | Yes | No: 16 bytes, one string, no structure |
| Process groups and sessions | No: `setsid()` or a new process group breaks it; daemons detach on purpose | `ps -eo pgid,sid` | `kill -- -pgid`; fails after detach | Yes | No |
| `PR_SET_PDEATHSIG` + `PR_SET_CHILD_SUBREAPER` | The signal fires when the parent thread or an ancestor subreaper dies ([PR_SET_PDEATHSIG(2const)](https://man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html), read 2026-10-04). Not a label: it is a death link | No listing | Kills the child when the parent dies; no listing, no later tree kill | Yes | No |
| Docker labels (for the sbx path) | Labels belong to the container object and its lifetime ([Docker labels](https://docs.docker.com/engine/manage-resources/labels/), read 2026-10-04) | `docker ps --filter label=...` | `docker rm -f` | Yes, if the user can use Docker | Yes: key-value pairs |

Notes:

- `RuntimeMaxSec` exists as a unit property, not as a dedicated flag of `systemd-run`; pass it with `--property=RuntimeMaxSec=...`. It terminates the unit after the time ([systemd.service(5)](https://man.archlinux.org/man/systemd.service.5.en), read 2026-10-04).
- `-G`/`--collect` sets `CollectMode=inactive-or-failed`, so the manager unloads the unit after it completed, even if it failed ([systemd.unit(5)](https://man.archlinux.org/man/systemd.unit.5.en), read 2026-10-04).
- Default `KillMode=control-group` kills all remaining processes of the cgroup on stop ([systemd.kill(5)](https://man.archlinux.org/man/systemd.kill.5.en), read 2026-10-04).
- `PR_SET_PDEATHSIG` survives `execve` except for set-user-ID, set-group-ID, or capability binaries. It is cleared on fork. The "parent" is the creating thread ([PR_SET_PDEATHSIG(2const)](https://man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html)).

## 2. `systemd-run --user` in WSL2

Facts and known problems:

- WSL does not create a login session for a shell. A user manager exists only after PAM runs or after a `user@<uid>.service` start; WSL injects `XDG_RUNTIME_DIR=/run/user/1000/` and `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus` itself ([WSL issue 8842](https://github.com/microsoft/WSL/issues/8842), read 2026-10-04).
- The bus socket at `/run/user/1000/bus` went missing in some WSL releases (2.5.x, a race with WSLg); a restart of `user@1000.service` fixed it; fixed in WSL 2.6.0 ([WSL issue 13043](https://github.com/microsoft/WSL/issues/13043), read 2026-10-04).
- `systemd-run --user --pty` failed with "Failed to connect to bus: No such file or directory" while the same call without `--pty` worked ([WSL discussion 10936](https://github.com/microsoft/WSL/discussions/10936), read 2026-10-04).
- After `wsl --shutdown` all processes and the user manager die. A tool starts again in a fresh VM; no stale unit survives. systemd itself drops transient units on reboot ([systemd cgroup interface](https://systemd.io/CONTROL_GROUP_INTERFACE/)).
- `su -` or `sudo -u` drops `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR`; a login through ssh keeps them ([unix.stackexchange 728274](https://unix.stackexchange.com/questions/728274/systemctl-user-issue-with-dbus-failed-to-connect-to-bus-dbus-session-bus-add), read 2026-10-04). Inside tmux the shell inherits these from the WSL `/init` on this host, because WSL sets them globally ([WSL issue 8842](https://github.com/microsoft/WSL/issues/8842)). Not verified on this host in this run, because the sandbox has no systemd.
- Linger: without a login session, the user manager stops when its last session ends. The main thread measured that three user services run already, so a user manager stays up. Not verified whether linger is on.

Assessment: `systemd-run --user` works on this host. The tool sets the two bus variables itself from the uid (`XDG_RUNTIME_DIR=/run/user/$UID`) when they are missing, and falls back when the socket does not exist.

## 3. How established tools label and clean up

- Docker: labels are key-value pairs with string values; `docker run --label` attaches them; `docker container ls --filter "label=..."` lists by label; labels are static for the object lifetime ([Docker labels](https://docs.docker.com/engine/manage-resources/labels/), read 2026-10-04).
- Testcontainers: a sidecar container called Ryuk performs "fail-safe cleanup of containers, and always required"; the "resource reaper is responsible for container removal and automatic cleanup of dead containers at JVM shutdown"; it tracks resources by session label and cleans up when the client disconnects; without it, cleanup happens at JVM shutdown "unless you `kill -9` your JVM process" ([testcontainers configuration](https://java.testcontainers.org/features/configuration/), read 2026-10-04). This is the same pattern as the forgotten loops here: cleanup that dies with the owner is not enough.
- GitHub Actions runner orphan cleanup: not verified. The reader did not find an ADR in `actions/runner`; the hosted runner image repository documents a cleanup service, but the sandbox could not read it in this run.
- GNOME and KDE session units: systemd starts each graphical application in a session `app-*.scope` unit; `systemd-run(1)` itself names "the session scope" as a mechanism to group a launched program ([systemd-run(1)](https://man.archlinux.org/man/systemd-run.1.en), read 2026-10-04). Details of the `app-*.scope` naming scheme: not verified in this run.
- `tini`: sets itself as init (PID 1) in a container and forwards signals; it reaps zombies and terminates its direct child. It labels nothing. Not verified in this run (tini GitHub README not read).
- tmux: the tmux server holds panes and their processes as children. It gives no label beyond pane and session names. Not verified in this run.

Pattern across tools: attach key-value metadata at start, and run cleanup that outlives the owner (Ryuk) or sits under a manager that tracks membership (Docker, systemd).

## 4. Node.js / bun libraries

Measured with the npm registry API on 2026-10-04 (`api.npmjs.org/downloads/point/last-week/...`):

| Package | Weekly downloads | Last release | Job |
|---|---|---|---|
| `tree-kill` 1.2.2 | 60,761,456 | 2019-12-11 (npm `time.modified`) | kills a process tree by pid |
| `execa` 10.0.1 | 206,718,623 | current (npm view) | child processes, `cancel()`/`kill` with signal and tree kill options |
| `@apify/ps-tree` 1.2.0 | 256,368 | 2023-03-01 | lists children of a pid |
| `fkill` 10.0.3 | 220,150 | 2026-01-14 | cross-platform kill by pid or name |

No npm package starts a child in a systemd scope or writes a cgroup. `tree-kill` walks children with `ps` or `pkill -TERM --parent` and is stale (last release 2019). `tree-kill` kills the tree only while the parent-child links hold; a double-forked daemon escapes it. For systemd there is only the D-Bus call, which `systemd-run` already wraps. Verdict: oc-sub calls `systemd-run` as a subprocess and does not add a dependency. The `tree-kill`/`ps-tree` family stays a fallback for hosts without systemd.

## 5. skills.sh

Query `process cleanup` (2026-10-04): 7 relevant skills, largest `paulrberg/agent-skills/process-cleanup` (78 installs), plus `stale-process-cleanup` (4), `orphaned-process-cleanup` (1), `custom-cleanup-process` (27). Query `process supervision`: no relevant skill, only unrelated top results. No skill covers labeling at start. The small install numbers mark them as immature; no project to adopt.

## 6. Recommendation for oc-sub

Deciding criteria: criterion 1 (survives detach), 2 (list by label), 3 (stop tree), 5 (works on this host), 8 (owner and reason as data). The environment variable alone fails 3; the process name fails 8; the cgroup path alone fails 8; the systemd scope passes 1, 2, 3, 5, and 8. Plain cgroups pass 1-3 but fail 4 on a non-delegated tree and need own code, against the "platform before own build" value.

Recommendation:

1. `oc-sub up` and the cost proxy loop start under the user manager: `systemd-run --user --unit=ocsub-<name> --description="owner=<session> reason=<why>" --slice=ocsub.slice --collect --property=RuntimeMaxSec=<limit> <command>`. The unit name is the handle, the description carries owner and reason as data. A child that detaches or double-forks stays in the scope, because cgroup membership does not depend on the parent. The cost proxy loop replaces the `sh -c "while :; do ...; done"` wrapper by a transient service with `Restart=on-failure` (`--property=Restart=on-failure`), so the manager itself does the restart.
2. `oc-sub doctor` lists `systemctl --user list-units 'ocsub-*' --all` plus their `Description`, and stops a tree with `systemctl --user stop <unit>`. A process that a doctor run cannot map to a unit, a session scope, or an owner is the orphan; doctor then reads `/proc/<pid>/environ` for a fallback `OCSUB_*` label variable that oc-sub sets on every child it starts directly. This covers the sbx Docker path, where oc-sub labels containers with `docker run --label owner=... --label reason=...` and lists with `docker ps --filter label=owner=...`.
3. Fallback without systemd (macOS, a container without a user manager): set an `OCSUB_OWNER` and `OCSUB_REASON` environment variable on every spawned process, and read it from `/proc/<pid>/environ` (Linux) or `ps -E` (macOS) for the listing. Stop with `tree-kill`-style tree walking. This path labels, lists, but does not stop a detached daemon; doctor reports that gap honestly. Tests start processes the same way as production, so a test leaves no unlabeled orphans after a failed cleanup, and the test runner stops the unit, not the tree.

Costs: one `systemd-run --user` call adds a D-Bus round trip, tens of milliseconds on this host class; not measured. The dependency is systemd (present on this host, absent on macOS and in sbx), so the fallback path stays. WSL2 risk: the user bus socket can go missing on WSL updates (seen in 2.5.x, fixed in 2.6.0); doctor then reports the systemd path as down and falls back. After `wsl --shutdown` no stale process or unit survives, so the VM restart itself is the strongest cleanup.

## Search log

| Query | Source | Relevant hits |
|---|---|---|
| `systemd-run --user --scope transient unit man page` | websearch | 6 |
| `WSL2 systemd user manager systemd-run DBUS_SESSION_BUS_ADDRESS tmux` | websearch | 5 |
| npm search `tree-kill process-kill cgroup systemd` | npm registry | 4 of ~10 |
| `api.npmjs.org` last-week downloads | npm API | 4 |
| skills.sh `process cleanup`, `process supervision` | skills.sh API | 7, 0 |

## Open questions

- Startup cost of `systemd-run --user` on this host (measure once `oc-sub up` uses it).
- Whether linger is enabled for the user on this host; if not, the user manager can stop when the last session ends, and a `--user` unit dies with it. Not verified.
- The exact `app-*.scope` naming scheme of GNOME/KDE; not verified in this run.
- GitHub Actions hosted runner orphan cleanup: the mechanism exists, but the sandbox did not read a primary source. Not verified.
- Behavior of `KillUserProcesses=yes` in `logind.conf` on this host: if on, session scopes die at logout; user-managed units do not. Not measured.

## Review of the main thread (2026-10-04)

Measurements on the host:

- `systemd-run --user --collect --wait --unit=ocsub-probe-N --description="owner=main reason=startup probe" true` operated 3 times with exit code 0. The times were 40 ms, 18 ms, and 18 ms. So the start cost is small.
- `loginctl show-user` shows `Linger=no`. `loginctl list-sessions` shows 3 sessions of the user (two `user`, one `manager`). The user manager stays up while a WSL shell is open. If the last session ends, the manager stops and its units stop too. For oc-sub this is correct, because no agent session runs then.
- `/etc/systemd/logind.conf` keeps `KillUserProcesses` at the default (`no`).

Corrections:

- Recommendation 2 names `docker run --label` for the sbx path. oc-sub does not operate `docker run`. It operates `sbx create` and `sbx exec` on the host. The host process of `sbx exec` can start inside a `systemd-run --user` unit like any other process, so the sbx path needs no Docker labels. Whether `sbx` itself can label a sandbox is not verified.
- The transient service, not the scope, is the correct form for `up` and the cost proxy. A scope keeps the process as a child of `systemd-run`, and `systemd-run` waits.

Decision of the main thread: oc-sub starts its long-lived processes (the host server, the cost proxy, the holder of `up`) as transient user services with the prefix `ocsub-`, an owner and a reason in the description, and `--collect`. `doctor` lists and stops these units. The `/proc` guess of step 30 stays as the fallback for a host without a user manager. This rests on these conditions: a running `systemd --user` on the host, and a start cost under 100 ms. If one changes, the decision is open again. Implementation is step 31 in `docs/PLAN.md`.
