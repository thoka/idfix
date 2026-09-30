# Run isolation: a sandbox that sees only the work of one run

Research date: 2026-09-30. Follow-up to [SANDBOX.md](SANDBOX.md).

Question: today `oc-sub up` mounts the whole project root read-write into one Docker Sandbox (`sbx` 0.45.1) per project. A run works in the git worktree `<root>/.worktrees/<step>`, but the agent can also reach the main checkout, every other worktree, and the shared `.git` folder. It could move `alpha`, delete branches, or damage the main checkout. How can the sandbox see only the work of one run?

Facts carry a source (URL, command, or file with line number). Statements marked **[guess]** are judgment. All git experiments ran in `.opencode/context/` of this worktree on 2026-09-30 and were cleaned up afterwards.

## 0. Short answers

1. Every established tool answers the worktree problem the same way: **the agent works in a full independent clone (or its own bare repo plus worktree) outside the source checkout, and the host pulls the result from that clone as a branch, a patch, or a PR.** None of them mounts a host worktree with its shared `.git` into the agent. (Section 1)
2. `sbx` already has this built in: `sbx create --clone` creates "a private in-container clone of the host Git repository (mounted read-only) instead of bind-mounting the workspace; the agent's commits are accessible via the sandbox-<name> git remote on the host" (`sbx create --help`). The host reviews and merges with plain `git fetch sandbox-<name>`. (Section 2)
3. Mounts of an existing sandbox cannot change. "Existing sandboxes retain their mounts until recreated" (https://docs.docker.com/ai/sandboxes/architecture/); only ports can be added later. (Section 3)
4. A worktree plus a writable overlay for the shared `.git` is possible with plain git (`GIT_OBJECT_DIRECTORY` plus `GIT_ALTERNATE_OBJECT_DIRECTORIES`, tested), but it cannot be expressed with `sbx` mounts, and one sandbox per run raises the start cost. (Sections 2.2, 4)
5. Recommendation: **option (a), a separate clone per run**, in the shape of `sbx create --clone` if it fits the oc-sub flow, otherwise an oc-sub-managed clone outside the project. It is the pattern of all prior art, it keeps `git diff alpha...feature/<step>` and the squash-merge unchanged, and a clone of this repository costs about 90 ms and 608 KB. (Section 6)

## 1. Criteria

From the Values of the global rules and the brief:

- C1 **One-run visibility.** The sandbox sees nothing but the work of one run: no `alpha`, no other worktrees, no shared refs.
- C2 **Simple review flow.** The main thread reviews with `git diff alpha...feature/<step>` and squash-merges into `alpha` as today.
- C3 **Low setup time.** The setup of a run stays fast (reference: a stopped `sbx` starts in about 3 s, a fresh `sbx create` took 65 s the first time; see SANDBOX.md section 7).
- C4 **Tests and installs work.** The agent can run the project tests (mise tools mounted read-only), install packages into its own copy, and commit.
- C5 **Key and config keep working.** The `{file:~/.config/<project>/openrouter.key}` placeholder and the project `.opencode/` folder behave as today.
- C6 **Small, maintainable oc-sub.** Little new host-side code, no fragile per-run state.
- C7 **Known failure modes are acceptable.** Hidden state a clone misses (hooks, untracked files, `node_modules`, `.opencode/context/`, submodules) must be handled or named.

## 2. Options

### 2.1 Option (a): a separate clone per run

`git clone` of the project into `~/.local/share/oc-sub/work/<project>/<step>/`, the sandbox mounts that clone (or its parent) as the workspace, the host fetches the branch from the clone.

Measured on this repository (commands in `.opencode/context/`):

- `git clone --no-local --no-hardlinks <worktree> c1`: **87 ms**, `.git` 608 KB. A `--shared` clone (`-s`) took 65 ms with a 192 KB `.git`.
- A clone made **from the worktree path** works: the clone resolved the branch that the worktree has checked out.
- Commit in the clone, `git fetch <clone> feature/<step>:refs/heads/feature/<step>` in the host worktree: works, the object lands in the shared object store, and `git diff alpha...feature/<step>` shows it as usual.

`--shared` clones use an alternates file that points at the host object store; the objects stay shared read-only, which is safe, but the clone then depends on the host `.git` staying in place. `--no-hardlinks`/`--no-local` gives a fully independent copy for 608 KB here; for a 1 GB-history repo the choice matters. Git also supports `--reference` with the same alternates mechanics.

Prior art for exactly this shape:

- **container-use (Dagger):** each environment is "a Git branch that syncs into the container-use/ remote" hosted in `~/.config/container-use/repos/<project>/` as a **bare repository**, with a worktree copy in `~/.config/container-use/worktrees/`. The source repo keeps its own branches; the host accepts the work with `cu merge` (keeps agent commits) or `cu apply` (stages the diff), which is a fetch from the bare remote underneath (https://github.com/dagger/container-use/blob/main/environment/README.md).
- **Claude Code on the web:** "Each session runs in a fresh Anthropic-managed VM with your repository cloned"; Claude pushes "the changes to a new branch in your GitHub repository", and `claude --teleport` "fetches and checks out the branch from the cloud session" locally (https://code.claude.com/docs/en/claude-code-on-the-web).
- **Codex cloud tasks:** one container per task on a snapshot of the branch; the result comes back as a unified diff that `codex apply` applies locally through `git apply` (https://community.openai.com/t/target-branch-changes-codex-fails/1278782, https://github.com/openai/codex/blob/f802f0a3/codex-rs/cloud-tasks/src/lib.rs).
- **Docker Sandboxes `--clone`:** see Section 3 — the same pattern, implemented by `sbx` itself.

Judgement:

| Criterion | Verdict |
|---|---|
| C1 one-run visibility | **Pass.** The clone is the only workspace; no shared refs are reachable. With `--clone`, the host repo is additionally readable at `/run/sandbox/source` read-only (Section 3) — the agent can *read* the main checkout, but not write it. |
| C2 review flow | **Pass.** `git fetch` from the clone, then `git diff alpha...feature/<step>` and squash-merge as today. One added step: the fetch (or `sbx` does it, see Section 3). |
| C3 setup time | **Pass.** Clone of this repo: ~90 ms. Only the first create of a sandbox is slow (65 s, mostly the 1.1 GB image), and that is unchanged. |
| C4 tests/installs/commit | **Pass.** The clone is a full working tree; `bun install` creates its own `node_modules` in it; the mise tools stay mounted read-only; commit works (tested in SANDBOX.md section 7 and above). |
| C5 key and config | **Mostly pass.** The placeholder key file lives in `$HOME` of the sandbox, not in the workspace (src/sandbox.ts, `placeholderKeyScript`), so it is unaffected. The tracked `.opencode/` folder ships with the clone; the untracked `.opencode/context/` does not (C7). |
| C6 oc-sub cost | **Low** with `sbx --clone` (oc-sub only adds the fetch before review), **medium** with a self-managed clone (clone, fetch, cleanup of `~/.local/share/oc-sub/work/`). |
| C7 hidden state | Git hooks: `git clone` does not copy hooks; `.git/hooks` stays in the host repo — oc-sub or the run setup would have to install needed hooks into the clone. Untracked files that tests need (`node_modules`, build outputs) are missing until `bun install` runs in the clone. Submodules: a clone needs `git submodule update --init` or `--recurse-submodules`. `.opencode/context/` is untracked and lost. |

Failure modes: stale clone when the run must follow new host commits (Codex has exactly this problem: "Tasks don't automatically track new commits on main" — https://community.openai.com/t/target-branch-changes-codex-fails/1278782); disk growth per run (cleanup needed); hooks and untracked state missing (C7).

### 2.2 Option (b): worktree plus writable overlay over the shared `.git`

Keep the worktree, hide the danger by giving the run its own object and ref storage. Tested in `.opencode/context/` with a scratch worktree of this repository:

- `GIT_OBJECT_DIRECTORY=<run>/god` plus `GIT_ALTERNATE_OBJECT_DIRECTORIES=<common-dir>/objects` let `git add` and `git commit` succeed; the new commit existed **only** in the run's object directory — the host repo could not see it, which is the isolation property.
- The result came back through a bare intermediate repository: push from the worktree (with the same env) into a scratch `--bare` repo, then `git fetch` from it into the host repo; afterwards `git cat-file -t` and `git log` saw the commit.
- Pitfall found: the alternates path must be the **common dir** (`<root>/.git/objects`), not the worktree's `.git` file path; with the wrong path git fails with `error: unable to normalize alternate object path` and every command dies. Refs also need care: `refs/bisect/`, worktree metadata, and `HEAD` stay in the shared `.git`, so the shared refs directory is still written unless every ref operation also goes through the env (refs are NOT covered by `GIT_OBJECT_DIRECTORY` — `git branch` writes into the shared `.git/refs`). **[fact from the test: the commit object went to the run dir; a branch created in the run wrote to the shared repo]**

So plain git gives *object* isolation but not *ref* isolation. A run could still update `alpha` unless `GIT_DIR` is fully redirected, which is the same as giving the run its own repository — that is option (a) with extra steps. On top, `sbx` cannot express this: mounts are fixed at creation and there is no writable-overlay mount flag (`sbx create --help` lists only path and `path:ro` workspaces), and `--clone` is "rejected from inside a Git worktree other than the main one. The read-only bind mount can't resolve the worktree's `.git` pointer file" (https://docs.docker.com/ai/sandboxes/usage/).

Judgement: C1 **partial** (objects yes, refs no without more machinery), C2 pass, C3 pass, C4 pass, C5 pass, C6 **fail** (hand-built plumbing that git and sbx do not support natively), C7 same hidden-state issues as (a) plus the refs gap. **Not recommended.**

### 2.3 Option (c): one sandbox per run

Today one sandbox serves one project; this option gives `oc-sub-<project>-<step>`. Isolation of the *workspace* still needs option (a) or (b) inside it — a per-run sandbox that mounts the whole root has the same problem. So (c) is an add-on, not an answer by itself.

Cost: `sbx create` of the same image per run would repeat the 65 s cold start only once per host (the image is cached), but each sandbox holds its own writable disk layer and its own stop/auto-stop lifecycle (SANDBOX.md section 7, problem 1: the sandbox stops 30 s after the last `sbx` session). Disk use per sandbox is not documented; measured numbers for the disk layer are an open question. Ports must be picked per run (already implemented, src/sandbox.ts `pickPort`).

Judgement: C1 pass (combined with (a)), C2 pass, C3 **partial** (a start of a stopped sandbox is ~3 s, but per-run create adds tens of seconds and lifecycle churn), C4 pass, C5 pass (per-sandbox secret scope exists: `sbx secret set --sandbox NAME`), C6 **fail** (state files, ports, secrets, and cleanup per run), C7 unchanged. **Not recommended now**; a per-run sandbox becomes attractive later if parallel runs of one project need hard resource isolation, since the workspace isolation comes from (a) anyway.

### 2.4 Option (d): `sbx create --clone` — the built-in version of (a)

From `sbx create --help`: "`--clone` — Run the agent on a private in-container clone of the host Git repository (mounted read-only) instead of bind-mounting the workspace; the agent's commits are accessible via the sandbox-<name> git remote on the host."

From the docs (https://docs.docker.com/ai/sandboxes/workflows/git/ and https://docs.docker.com/ai/sandboxes/architecture/):

- "In clone mode, `sbx` creates a separate Git clone inside the sandbox. The agent edits this clone instead of your host working tree... The sandbox clone is not a Git worktree linked to your host checkout."
- "The host repository is also available at `/run/sandbox/source`, but only with read access."
- A git daemon inside the sandbox exposes the clone; the CLI **adds a `sandbox-<name>` remote to the host repository**, and the host pulls with `git fetch sandbox-<name>` then `git checkout -b <branch> sandbox-<name>/<branch>`, or "ask the agent to push directly." `sbx rm` removes "the daemon, the published port, and the `sandbox-<name>` remote entry"; `sbx stop` stops the daemon and a restart "assigns another ephemeral port... The CLI updates the `sandbox-<name>` remote URL."
- The CLI "copies Git remotes from your host repository... into the in-sandbox clone" (local-path remotes excepted).
- Extra workspaces can be mounted alongside ("The first path is the primary workspace"; extras with `:ro`, https://docs.docker.com/ai/sandboxes/usage/).
- Limits: clone mode is create-time only and "cannot be changed on an existing sandbox"; and it "is rejected from inside a Git worktree other than the main one" — oc-sub must run `sbx create --clone` against the **main checkout root**, not the worktree.

This is option (a) with the clone, the git daemon, the host remote, and the fetch plumbing maintained by Docker. The host review flow becomes `git fetch sandbox-oc-sub-<project>` and the same `git diff alpha...feature/<step>` as today. The read-only `/run/sandbox/source` mount is the one visibility leak: the agent can read the main checkout's files (but not other worktrees' working files, and not write anything).

Judgement: C1 **pass with one named leak** (read-only source visible), C2 pass (fetch from the managed remote), C3 pass, C4 pass, C5 pass, C6 **best of all options** (no new oc-sub plumbing for the return path), C7 same hidden-state list as (a) — clone mode gives the agent "anything committed to the repo"; untracked files are not in the clone. Untested here: the sandbox-login expired, so `--clone` with the oc-sub opencode kit and with `OPENCODE_CONFIG_DIR` has not been run end to end (open question).

### 2.5 Option (e): git as a narrow interface driven by oc-sub on the host

The user's idea: the sandbox gets only the files of the run — no `.git` at all. Git operations go through a shim: an MCP tool, or a `git` wrapper in the sandbox that forwards to oc-sub on the host, which runs real git in the host worktree and allows only `status`, `diff`, `log`, `add`, `commit` on the branch of the run — never branch changes, reset, push, or ref writes.

**(1) Channel from the sandbox to the host.** The sandbox must reach a host service. Three candidates:

- **Network to a host port.** Today the per-sandbox policy denies exactly this: `NETWORK_DENY_HOSTS` covers `host.docker.internal`, `localhost`, `127.0.0.0/8`, and all private ranges (src/sandbox.ts lines 37–44), and "a deny rule always beats an allow rule" (SANDBOX.md problem 3). To allow one port, the deny list would have to be rebuilt as `deny **` plus explicit allows (openrouter.ai, Exa, registries, the one host port) — SANDBOX.md records that `deny **` also blocked openrouter.ai even with a more specific allow rule, so this path means re-proving the whole egress matrix. Port-qualified resources exist (`sbx policy check network ... host.docker.internal:8767`), but whether an allow for `host.docker.internal:<port>` can coexist with a deny for the same host on other ports is untested. **[fact for the current deny; guess for the rework]**
- **A shared read-write folder used as a request queue.** Works with the mounts `sbx` already has: the shim writes a request file, the host oc-sub process polls the folder, runs git, writes the response. No network rules change, no new egress. Cost: polling latency and a small protocol to design and maintain. This is the fallback if the network path stays denied.
- **A Unix socket inside a mount.** A Unix socket needs the same kernel on both ends. Docker Sandboxes run in a microVM on Docker Desktop (SANDBOX.md: "The primary trust boundary is the microVM"), and Docker Desktop's file sharing does not generally forward Unix sockets across the VM boundary. **[guess — untested, likely not available]**

**(2) Prior art: git MCP servers.** The official `mcp-server-git` (modelcontextprotocol/servers, `src/git`) exposes exactly a small tool set — status, diff unstaged/staged, diff, commit, add, reset, log, create_branch, checkout, show, branch — with `--repository` as the single allowed root (`validate_repo_path`), and per-tool annotations (`readOnlyHint`, `destructiveHint`). Its history shows why an allowlist must be strict: CVE-2026-27735 — `git_add` staged files outside the repository through `../` paths until version 2026.1.14 (https://github.com/advisories/GHSA-vjqx-cfc4-9h6v), and a path-restriction bypass was fixed in 2025.9.25 (PR #2757). The repo itself says the servers are "reference implementations... not production-ready solutions". No existing git MCP server implements the *forwarding* shape (tool call in sandbox → git on host) or a branch-locked write allowlist; oc-sub would build that.

**(3) opencode registration and per-agent tool scoping.** From https://opencode.ai/docs/mcp-servers/ and https://opencode.ai/docs/config/:

```jsonc
{ "mcp": { "oc-git": { "type": "local", "command": ["oc-sub", "git-mcp"], "enabled": true } } }
```

Local stdio servers work, per-project via `.opencode/opencode.json` ("Project config has the highest precedence among standard config files") and via `OPENCODE_CONFIG_CONTENT` ("runtime overrides", which is what the sandbox mode already uses). Per agent: "Disable it as a tool globally. In your agent config, enable the MCP server as a tool" — `tools: { "oc-git*": false }` globally, `agent: { coder: { tools: { "oc-git*": true } } }`. MCP tools are registered with the server name as prefix. Permission rules are keyed by tool name with per-agent overrides (https://opencode.ai/docs/permissions/), so the same gating can be expressed as permissions. Note: the sandbox config today disables the `sbx` MCP gateway in `sandboxConfigContent` (src/sandbox.ts lines 82–89) — a local stdio MCP server spawned inside the sandbox is a different mechanism and would be spawned by opencode itself, inside the microVM.

**(4) Files without `.git`, and the way back.** The worktree's `.git` is a *file* pointing into `<root>/.git/worktrees/<name>`; `sbx` mounts are whole directories and the docs describe no per-file exclusion, so a plain mount of the worktree cannot hide that file. Two workable shapes:

- **Mount a copy.** oc-sub creates a per-run copy of the worktree files minus `.git` (rsync excluding `.git`) under `~/.local/share/oc-sub/work/...` and mounts that as the primary workspace. The agent edits the copy; for each git request, the host side syncs sandbox→worktree, runs the allowed git command, and syncs worktree→sandbox so the agent sees the committed state. Bidirectional sync is the fragile part: any git operation between syncs can race with the agent's edits, and conflict handling must be invented. This is the same state that container-use manages with automatic commits to the environment branch after every command (https://github.com/dagger/container-use/blob/main/environment/README.md) — container-use chose *git itself* as the sync mechanism, which is option (a)-shaped.
- **Mount the worktree directly but keep the agent off `.git`.** Not expressible with today's `sbx` mounts, and the agent has sudo inside the microVM ("The agent has full control inside the VM, including sudo access", https://docs.docker.com/ai/sandboxes/), so nothing inside the VM can enforce it. **Fails C1.**

Judgement: C1 pass for the tool surface (the allowlist can be exact) but the *files* copy leaks nothing only if the copy excludes `.git` and everything else; C2 pass (git runs on the host worktree, review unchanged); C3 **fail** (a per-run copy, a request protocol, a queue, and a sync loop are all new per-run machinery); C4 pass for tests and installs (the copy is a normal folder; commits go through the shim, which is slower and loses git UX — the agent cannot run `git log`, hooks, or `git stash` except through the shim); C5 pass; C6 **fail** (the largest amount of new oc-sub code of all options: protocol, sync, allowlist, and a CVE surface like mcp-server-git's); C7 the sync loop must also copy untracked files in both directions. The core tension: the agent still needs *file* writes to flow back to the host worktree, and only a mount or a sync provides that — a mount of the worktree brings `.git` back in, and a sync is option (a)'s clone with a hand-written transport. **Not recommended.**

## 3. Can `sbx` change the mounts of an existing sandbox?

No. "Existing sandboxes retain their mounts until recreated" (https://docs.docker.com/ai/sandboxes/architecture/), and for clone mode specifically: "`--clone` is a create-time flag and cannot be changed on an existing sandbox. To change a sandbox from clone mode to direct mode, remove and recreate it" (https://docs.docker.com/ai/sandboxes/workflows/git/). What can change on an existing sandbox: published ports (`sbx ports --publish`), policies (`sbx policy ... --sandbox`), and secrets. This matches the current oc-sub error path that asks to `sbx rm` and re-create (src/sandbox.ts lines 556–562). Every new mount therefore costs a `sbx create` and the loss of the sandbox's sessions.

## 4. Hidden state that a clone misses

Checked against this repository and the docs:

- **Git hooks:** `git clone` does not copy hooks. Hooks live in `<root>/.git/hooks`; if a run needs one (for example a pre-commit formatter), the run setup must install it into the clone (copy from the host repo or from a tracked folder). Same for container-use and for `sbx --clone` — the docs say only "anything committed to the repo is available" (Claude Code web, same clone semantics).
- **Untracked files that tests need:** `node_modules` (created by `bun install`), build outputs, local data. A clone starts without them; the run must reinstall. Mitigation: oc-sub already runs `mise install` before `up` (src/sandbox.ts lines 506–513); a `bun install` inside the clone is the same shape. Copying a host `node_modules` into the clone would speed the first test run but risks host/sandbox binary mismatches.
- **`.opencode/context/`:** untracked scratch space of this project; it does not travel with a clone. Anything a run needs from it must be committed, mounted as an extra read-only workspace, or copied by oc-sub.
- **Submodules:** a plain clone misses them; the clone step needs `--recurse-submodules` (or `git submodule update --init` in the run). This repository has none today.
- **Uncommitted host changes:** a clone takes committed state only. That is the desired boundary — the main thread should commit or stash before starting a run, or the run starts from a stale base (the Codex stale-snapshot problem).

## 5. Cost of the options at a glance

| | (a) clone per run (self-managed) | (b) worktree + overlay | (c) sandbox per run | (d) `sbx --clone` | (e) git shim through oc-sub |
|---|---|---|---|---|---|
| C1 one-run visibility | pass | partial (objects only) | pass with (a) | pass (source read-only visible) | pass (tool surface), files via copy |
| C2 review flow | pass (host fetch) | pass | pass | pass (`sandbox-<name>` remote) | pass |
| C3 setup time | ~90 ms clone + reused sandbox | pass | adds per-run create | pass | copy + queue setup |
| C4 tests/installs/commit | pass | pass | pass | pass | pass, commit only via shim |
| C5 key + `.opencode/` | pass (placeholder in `$HOME`) | pass | pass | pass | pass |
| C6 oc-sub effort | low–medium | high, unsupported plumbing | high state churn | **lowest** | **highest** (protocol, sync, CVE surface) |
| C7 hidden state | hooks, untracked, submodules (Section 4) | same + refs gap | same | same | same + sync races |

## 6. Recommendation

**Option (d), `sbx create --clone`, is the first choice; option (a) in its self-managed form is the fallback.** The deciding criteria are C6 (oc-sub stays small — Docker maintains clone, git daemon, remote, and port bookkeeping) and C1 (a real independent clone, the same structure every prior art tool uses: container-use's bare remote, Claude web's cloud clone, Codex's task container). C2 keeps working because the result arrives as a normal branch on a git remote, so `git diff alpha...feature/<step>` and the squash-merge into `alpha` are unchanged. Option (c) solves a different problem (resource isolation per run) and rides on (a)/(d). Options (b) and (e) build plumbing that git and `sbx` do not support natively, for a property that a plain clone already gives.

Concrete shape for oc-sub: create the project sandbox with `--clone` from the **main checkout root** (not from a worktree — the docs reject that), keep the plugin, mise-installs, and shared-agents read-only mounts as extra workspaces, run `opencode serve` as today, and teach the review step to `git fetch sandbox-oc-sub-<project>` before `git diff alpha...feature/<step>`. The `sbx` secret and placeholder-key mechanism (C5) is untouched by the workspace mode.

## 7. Open questions

- `sbx create --clone` end to end with the oc-sub opencode kit, `OPENCODE_CONFIG_DIR`, and a run started from the main checkout root: untested here (the `sbx` session was not authenticated, and running `sbx` from this sandbox is out of scope).
- Does the `sandbox-<name>` remote get added to the repository that `sbx create` was pointed at, and can oc-sub read the remote URL from `sbx` output or `git remote -v` reliably across a sandbox restart (the URL changes, the CLI updates it)?
- Can an `sbx` network allow rule for one `host.docker.internal:<port>` coexist with denies for the same host on other ports (needed only if option (e) ever comes back)?
- Do Unix sockets cross the Docker Sandboxes file-sharing boundary into the microVM? Untested; assumed no **[guess]**.
- Disk use of a `--clone` sandbox versus a direct-mount sandbox over many runs, and the cleanup story (`sbx rm` removes the remote, but the writable disk layer goes only with the sandbox).
- Whether the read-only `/run/sandbox/source` view of the main checkout is acceptable to the user, or must be removed (it is part of clone mode; no documented flag turns it off).

## 8. Test of the main thread on the host (2026-09-30)

The main thread tested `sbx create --clone` on the host with a scratch repository (branch `alpha`, one commit). Commands: `sbx create --clone --name oc-clone-spike opencode <repo>`, then `sbx exec` for the steps inside.

| Test | Result |
|---|---|
| Time of `sbx create --clone` (image cached) | 6 s |
| Path of the clone inside the sandbox | the same absolute path as on the host, with its own `.git` folder |
| Remote on the host | `sandbox-oc-clone-spike git://127.0.0.1:<port>/clone-spike` |
| `git worktree add -b feature/x .worktrees/x` inside, then a commit | works |
| Write to `/run/sandbox/source` inside | `Read-only file system` |
| Host `alpha` after the agent moved its own `alpha` | unchanged (the agent only changes its clone) |
| `git fetch sandbox-<name>` on the host, then `git diff alpha...sandbox-<name>/feature/x` | works, shows the commit of the agent |
| A host commit after create, then `git fetch /run/sandbox/source alpha` inside | works: the remote `origin` of the clone is `/run/sandbox/source` |
| `sbx rm` | removes the sandbox and the remote on the host |

Open questions 1 and 2 of section 7 are answered for a scratch repository. The end-to-end test with the oc-sub kit remains for the implementation step.

## 9. Live test of the main thread with the oc-sub kit (2026-09-30)

The main thread ran `oc-sub up` for this project on the host. It found two faults of clone mode that the scratch test of section 8 did not show.

**A mount inside the project root stops the clone silently.** `oc-sub up` ran `sbx create --clone --name oc-sub-opencode-subagents opencode <root> <root>/opencode:ro <installs>:ro <shared>:ro`. The plugin folder `<root>/opencode` lies inside the project root, because this project is the plugin itself. `sbx create` exited 0, but inside the sandbox `<root>` held only the mount point `opencode/` and no clone: `git -C <root> ...` gave "not a git repository". A scratch test repeated it: `sbx create --clone` with `<repo>/sub:ro` as an extra mount gave no clone, and the same create without the nested mount gave a working clone. The project `meta` has the same fault, because the shared agents folder `~/dv/meta/agents` lies inside its root.

Consequence for oc-sub: a folder inside the project root (or equal to it) gets no mount. The clone holds its tracked files at the same absolute path, so the paths in the configuration still work. The gap: the sandbox uses the committed copy, not the live host folder, and untracked files of that folder are missing. Because the create exits 0, `up` also checks `sbx exec NAME git -C <root> rev-parse --git-dir` after the create and on every later `up`.

**The clone copies the remotes of the host.** When the host repository has `origin` (for example `git@github.com:thoka/opencode-subagents.git`), `origin` in the clone is that same URL. `git fetch origin` inside the sandbox then fails, because the sandbox has no SSH access. Only for a host repository without a remote is `origin` in the clone `/run/sandbox/source` (the case of section 8). Consequence for oc-sub: the clone fetches new host commits from its own remote `host` that points to `/run/sandbox/source`, never from `origin`.

Other facts of the same test:

- The host fetch refspecs of the `sandbox-<name>` remote are `+refs/heads/*:refs/remotes/sandbox-<name>/*` and `+refs/heads/*:refs/sandboxes/<name>/*`, so `git fetch sandbox-<name>` on the host works as `oc-sub fetch` expects.
- `sbx rm` without a terminal needs `--force`, so every fix text of oc-sub names `sbx rm --force NAME`.
- `sbx stop` removes the `sandbox-<name>` remote from the host repository (a later test with sbx 0.45.1 on 2026-09-30). It prints "Git remote sandbox-<name> is restored when the sandbox next starts". Any start adds the remote again with a new port: `sbx exec` on a stopped sandbox does it, and `sbx run --detached --name NAME` does it, too. The docs quote of section 2.4 ("The CLI updates the `sandbox-<name>` remote URL") hides this gap. Consequence for oc-sub: the check for clone mode through the remote must run after the sandbox starts. A stopped direct-mount sandbox shows no remote after a start either, and it has no `/run/sandbox/source`.
