# A real sandbox for opencode runs instead of permission rules

Research date: 2026-09-29. Written for step 9 of [PLAN.md](../PLAN.md).

Question: how can `oc-sub` run an opencode agent in a real sandbox, so that the agent files need no long permission rules?

Today one `opencode serve` runs on the host at 127.0.0.1:8767 and serves many project folders. Each run works in a git worktree `<repo>/.worktrees/<step>`. The user watches with `opencode attach`. The OpenRouter key sits in `~/.config/<project>/openrouter.key`. Host: Linux on WSL2.

Facts carry a source (URL or file with line number). Statements marked **[guess]** are judgment.

## 0. Short answers

1. Established tools sandbox coding agents in three ways: OS-level sandboxing with bubblewrap (Claude Code on Linux/WSL2), containers/microVMs per agent (container-use, Docker Sandboxes), and hosted microVMs (E2B). None of them has opencode in mind, but opencode itself ships an official Docker image, so containers work today. (Sections 1–2)
2. opencode offers no sandbox, container, or devcontainer mode. Docker is only an install option. (Section 3)
3. ACP does not help with sandboxing. It is a transport (stdio JSON-RPC per process), and it would cost us the shared server, `opencode attach`, and the child-session cost view. (Section 4)
4. Recommendation: a Docker container per project (not per run) that runs `opencode serve`, with the worktrees bind-mounted and the network limited to OpenRouter and package registries. `oc-sub` keeps its HTTP API and just points at a different port; agent files drop to allow-all bash. (Section 5)

## 1. What established tools use

### 1.1 Docker or Podman per run or per project

The standard pattern is a container per agent run with the repository bind-mounted in. opencode itself supports it: the docs list `docker run -it --rm ghcr.io/anomalyco/opencode` as an install option ([https://opencode.ai/docs/](https://opencode.ai/docs/), Install section). container-use (Dagger) is the most prominent per-run-container tool (Section 1.4). Nothing stops `opencode serve` from running inside a plain container; the server binds a port inside the container, which the host publishes.

### 1.2 Bubblewrap — the Claude Code sandbox on Linux

Claude Code's sandbox on Linux and WSL2 is **not** a container. It relies on two packages: "bubblewrap: the unprivileged sandboxing tool that enforces filesystem isolation" and "socat: the relay used to route network traffic through the sandbox proxy" ([https://code.claude.com/docs/en/sandboxing](https://code.claude.com/docs/en/sandboxing)). Key points, all from that page:

- It works on "macOS, Linux, and WSL2" (WSL2 only, not WSL1; macOS uses Seatbelt instead).
- Filesystem: read access to the whole computer by default, write only to the working directory, `--add-dir` directories, and per-user temp. Allow/deny lists (`sandbox.filesystem.allowWrite`, `denyWrite`, `denyRead`) are "enforced at the OS level", so they also bind child processes.
- Network: a proxy outside the sandbox controls egress; domains are allow-listed via `network.allowedDomains`, optionally `strictAllowlist: true`.
- Credentials: `sandbox.credentials` can block or mask credential files and env vars.
- If dependencies are missing, Claude Code by default "shows a warning and runs commands without sandboxing"; `sandbox.failIfUnavailable` makes it a hard failure.
- Caveat on Ubuntu 24.04+ (including WSL2): AppArmor may block unprivileged user namespaces (`kernel.apparmor_restrict_unprivileged_userns`); the docs give an AppArmor profile for bubblewrap.

So bubblewrap is proven on exactly our platform (WSL2), starts in milliseconds, and isolates filesystem and network without images. But it is a feature of Claude Code, not a standalone product — we would have to build the bwrap wrapper and the network proxy ourselves.

### 1.3 MicroVMs: Firecracker and E2B

Firecracker: "Boot in <125ms. Create up to 150 microVMs per second per host", memory footprint "< 5 MiB" ([https://firecracker-microvm.github.io/](https://firecracker-microvm.github.io/)). It "runs in user space and uses the Linux Kernel-based Virtual Machine (KVM)". It needs a Linux host with hardware virtualization and `/dev/kvm`. Whether nested KVM works inside WSL2 is not documented on the Firecracker pages; WSL2 nested virtualization is not a supported Firecracker setup **[guess — treat WSL2 Firecracker as unavailable until proven]**. A shipped kernel and guest setup (rootfs, kernel images, network config) would also be our own work.

E2B is a hosted service built on Firecracker (confirmed on the Firecracker site's integration list): "E2B provides isolated sandboxes that let agents safely execute code, process data, and run tools" ([https://e2b.dev/docs](https://e2b.dev/docs)). The sandbox is "a fast, secure Linux VM created on demand", pausable and resumable. It is cloud-hosted: the code and the repository leave the machine, the API key sits at E2B, and `opencode serve` would have to run inside a custom E2B image. Wrong fit for runs that must stay local and cheap.

### 1.4 container-use (Dagger)

"Container Use lets coding agents do their work in parallel environments without getting in your way. It's an open-source MCP server ... Powered by Dagger" ([README](https://raw.githubusercontent.com/dagger/container-use/main/README.md)). Each agent gets "a fresh container in its own git branch". Visibility and control: `container-use log <env>` for the full command history, `container-use terminal <env>` to "drop into the live container environment", `container-use diff` and `checkout` to review and merge.

Secrets: "Secrets are resolved within the container environment — agents can use your credentials without the AI model ever seeing the actual values" ([https://container-use.com/secrets.md](https://container-use.com/secrets.md)). References like `env://OPENROUTER_KEY` are stored in config, resolved when a command runs, injected as env vars in the container, and "stripped from logs".

Network: none of the fetched docs mentions any default network restriction. **[fact: no documented default network policy]**. And its shape is wrong for us: it is an MCP server the *agent* talks to, built around Claude Code-style agents, not a way to host `opencode serve`.

### 1.5 Docker's own offer: Docker Sandboxes

Docker Sandboxes "run AI agents in microVMs so they can execute code, install packages, and use tools without accessing host resources beyond those you share" ([https://docs.docker.com/ai/sandboxes/](https://docs.docker.com/ai/sandboxes/)). Highlights from the docs:

- "The primary trust boundary is the microVM. The agent has full control inside the VM, including sudo access."
- Credential isolation: "the host-side proxy injects authentication headers into outbound HTTP requests. The raw credential values never enter the VM." This is the strongest key model of all options — even the agent process cannot read the key.
- Network: "outbound TCP traffic is proxied through the host and governed by a deny-by-default policy."
- The workspace is shared on the host and changes are "visible on your host in real time" (direct mount), or the agent works on a private clone (`--clone`).

This is the best-designed option, but it is built to run its own supported agents inside the microVM. Whether opencode can run inside a Docker Sandbox, and how a server inside it would be reached, is not documented — open question. The free local `sbx` CLI runs on Docker Desktop, which itself runs on WSL2.

## 2. How opencode runs inside each option

| Option | opencode inside | `oc-sub` and `attach` reach it | Key in, code-safe | Network limit | Start on WSL2 |
|---|---|---|---|---|---|
| Docker/Podman container | `opencode serve` in a container (official image exists) | Publish the container port to 127.0.0.1 on the host; URL unchanged from oc-sub's view | Key file bind-mounted read-only into the container, e.g. `/run/secrets/openrouter.key`; agent in the worktree cannot read it **but the key sits in the serve process env, which a shell can echo** | Docker network with an egress proxy, or a firewall/userland proxy that allows only openrouter.ai and the registries | Docker Desktop on WSL2; container start in seconds, image pulled once |
| bubblewrap (Claude Code style) | opencode runs on the host, wrapped in `bwrap` | Unchanged — the server is still on the host | `--ro-bind` for the key file only; credential masking needed for env, as Claude Code does with `sandbox.credentials` | socat relay through a host proxy with a domain allowlist | Yes, documented by Claude Code; AppArmor caveat on Ubuntu 24.04 |
| Firecracker | serve in the guest VM | Port forward from the host into the VM | Key injected via guest config or metadata service | VM network rules | Not supported on WSL2 **[guess]** |
| E2B | serve in a custom sandbox image | Via E2B's tunnel/host mapping | Key as E2B env var; code runs in the same VM, so it can read the env | E2B's hosted network controls | Works everywhere, but cloud-hosted |
| container-use | Not designed for hosting a server; it gives the *agent* container tools | n/a | Secret references resolved inside the container, stripped from logs | None documented | Works where Docker works, so WSL2 |
| Docker Sandboxes (`sbx`) | Not documented that arbitrary servers can run inside | Not documented | Best model: "the raw credential values never enter the VM" | "deny-by-default policy", proxied through the host | Runs on Docker Desktop, so WSL2 |

The key problem, stated honestly: opencode needs the OpenRouter key in its process environment to call OpenRouter. Any setup where opencode runs where the agent also runs lets the agent read that env (`echo $KEY`). A container or bubblewrap protects *files and the host*; only a host-side credential proxy — Docker Sandboxes' model, or the local proxy planned in step 11 of PLAN.md — keeps the key fully out of the agent's reach.

## 3. Does opencode offer a sandbox itself?

No. The docs index lists no sandbox, container, devcontainer, or security page ([https://opencode.ai/docs/](https://opencode.ai/docs/)); the closest items are the Permissions and Policies pages, which are rule-based like ours. Docker appears only as an install option (`ghcr.io/anomalyco/opencode`). Nothing in the docs or changelog points to a sandbox mode in v1.18.x or in the announced v2 architecture (shared background server per user, `--standalone`, `--server URL`).

## 4. Agent Client Protocol (ACP)

opencode speaks ACP: "To use OpenCode via ACP, configure your editor to run the `opencode acp` command. The command starts OpenCode as an ACP-compatible subprocess that communicates with your editor over JSON-RPC via stdio" ([https://opencode.ai/docs/acp/](https://opencode.ai/docs/acp/)). The ACP agents list includes OpenCode alongside Gemini CLI, Claude (via adapter), Codex CLI, Cursor, Goose, and roughly 40 others ([https://agentclientprotocol.com/overview/agents](https://agentclientprotocol.com/overview/agents)). opencode's docs say "OpenCode works the same via ACP as it does in the terminal. All features are supported", including the permissions system.

What ACP covers: session creation and streaming updates, tool calls, permission requests (`session/request_permission`, with `allow_once`/`allow_always`/`reject` options), and elicitation. What it does not cover for us:

- **No shared server.** Each ACP session is one opencode subprocess per client. `oc-sub` would spawn and manage one process per run instead of talking to one server for all projects and worktrees.
- **No `opencode attach`.** The TUI attach works against the HTTP server; an ACP subprocess has no attachable server.
- **No child-session cost view.** ACP has no concept of opencode's `task` tool child sessions, so the step 2 cost accounting of `oc-sub watch` would break.
- Cost/usage reporting is not part of the ACP surface opencode documents.

ACP is a transport, not an isolation mechanism — it answers none of the sandbox questions. **Verdict: do not switch.** Keep the HTTP API.

## 5. Recommendation

Run `opencode serve` in a **Docker container per project** (Podman works the same). `oc-sub up` starts the container instead of a host process: the container runs the official opencode image, bind-mounts the project folder (so all worktrees are visible) read-write, bind-mounts `~/.config/<project>/openrouter.key` read-only to a fixed path outside the worktree, and publishes the serve port to 127.0.0.1 on the host. Everything else in `oc-sub` keeps working unchanged: the HTTP API, `watch`, `answer`, and the user's `opencode attach http://127.0.0.1:<port>` all just point at the published port. The network is limited by putting the container on a custom Docker network whose only egress is a small proxy that allows openrouter.ai and the package registries. The agent files then allow all bash commands; only a few actions that reach outside the container still ask, for example `git push`.

Limits: the container start takes seconds and needs Docker (Desktop) on WSL2; the key stays in the serve process environment, so a determined agent inside the container can still read it from its own shell — the container protects the host and the files, not that env var. The step 11 local proxy (or the Docker Sandboxes credential-proxy model) is the only full fix for the key. Firecracker is out on WSL2 **[guess]**, E2B sends code to the cloud, container-use is agent-facing MCP rather than a server host, and ACP would cost us the shared server, `attach`, and child-session cost. A pure bubblewrap approach is lighter and starts instantly, but we would have to build and maintain the wrapper and network proxy that Claude Code already built for itself — a possible later simplification, not the first step.

What `oc-sub` keeps: `up/run/watch/answer/log` semantics, the HTTP API, `opencode attach`, the run records, and the real-cost line. What it drops (per project switched to a container): long bash allowlists in agent files (allow-all inside the sandbox), and the host as the trust boundary — the sandbox replaces it.

## 6. Open questions

- Does opencode run correctly inside a Docker Sandbox microVM, and can a server inside it be reached from the host? Answered yes by the test in section 7.
- Does the official opencode image (`ghcr.io/anomalyco/opencode`) work as a headless `serve` image as-is, or does it need a small Dockerfile on top?
- Nested KVM in WSL2 for Firecracker — unverified; assumed unavailable.
- What egress does an opencode run actually need beyond openrouter.ai (models.dev catalog fetch, npm/bun/pip installs, GitHub)? Determines the proxy allowlist. Section 7 lists what one small run used.
- E2B and Docker Sandboxes start-time and pricing numbers were not on the fetched pages.

## 7. Test of Docker Sandboxes on 2026-09-29

Setup: `sbx` 0.45.1 on WSL2, logged in with `sbx login`, one local sandbox `oc-test` for a scratch git repository. The user chose this test before our own container, because the credential proxy of `sbx` keeps the key out of the sandbox.

### What works

- `sbx create --name oc-test opencode DIR` took 65 seconds the first time, mostly for a 1.1 GB image. A start of a stopped sandbox took about 3 seconds.
- The sandbox runs Ubuntu 26.04 with opencode 1.18.32, the same version as `mise.toml`. The user is `agent`. The workspace appears under the same absolute path as on the host. The home folder of the host is not visible.
- `sbx secret set openrouter --sandbox oc-test --command 'cat ~/.config/<project>/openrouter.key'` scopes the key to one sandbox. `sbx` runs the command on the host.
- Inside, `OPENROUTER_API_KEY` holds the placeholder `proxy-managed`. The proxy of `sbx` (`HTTPS_PROXY=http://gateway.docker.internal:3128`) adds the real key to each request to openrouter.ai, also to a request without an `Authorization` header. The agent can use the key but cannot read it.
- `opencode serve --hostname 0.0.0.0 --port 4096` runs inside. `sbx ports oc-test --publish 18767:4096` publishes it on 127.0.0.1 of the host. `oc-sub watch`, `oc-sub say`, and `oc-sub answer` work unchanged with `OC_SUB_URL=http://127.0.0.1:18767`.
- The plugin agents work after `sbx cp opencode oc-test:/home/agent/oc-sub-config` and `OPENCODE_CONFIG_DIR=/home/agent/oc-sub-config`. A mount of the plugin folder read-only (`sbx create ... PLUGIN_DIR:ro`) is the likely better way.
- A small `coder` run with GLM 5.3 Flash wrote a file and committed it, in 13 tool calls for an estimated 0.0024 USD. `sbx` copies the git identity of the host into the sandbox.
- The sessions of opencode survive a stop of the sandbox, because the disk of the sandbox persists.

### Problems found

1. Auto-stop. `sbx` stops a sandbox 30 seconds after the last `sbx` session (for example `sbx exec` or `sbx run`) disconnects. Traffic through a published port does not count. A server that is started in the background with `sbx exec ... &` dies with the sandbox. No setting turns the auto-stop off. The fix: a host process holds `sbx exec -e OPENCODE_CONFIG_DIR=... SANDBOX opencode serve ...` in the foreground for the life of the server. `oc-sub up` can start this process instead of `opencode serve`.
2. The key check of `oc-sub run` refuses the sandbox. It resolves the key of the run directory, finds `proxy-managed`, and reports that the project does not use its project key. With `sbx`, the key check must use the `sbx` secret scope instead.
3. The network is open by default. The global policy `local-policy` has the rule `default-allow-all`. The kit of the agent `opencode` adds 31 allowed hosts (openrouter.ai, api.github.com, registry.npmjs.org, and others), but they matter only when the global rule is removed. A deny rule always beats an allow rule, so `sbx policy deny network --sandbox oc-test "**"` also blocks openrouter.ai, even with a more specific allow rule. A per-sandbox allowlist needs a change of the global policy (`sbx policy rm network --id default-allow-all`), which affects every sandbox.
4. The sandbox reaches the host. `curl http://host.docker.internal:8767` from inside reached the host `opencode serve`, which runs without a sandbox. An agent can create a session there and run commands on the host. `sbx policy check` allows it under the current global policy. If the plugin moves to `sbx`, the host server must stop, or the policy must deny `host.docker.internal`.
5. A background `pkill -f "opencode serve"` inside `sbx exec sh -c '...'` also matches the shell of that command. Stop the server through its holding host process instead.

### Egress of one small run

The policy log (`sbx policy log oc-test`) showed these hosts: openrouter.ai, models.opencode.ai (the model catalog), registry.npmjs.org (29 requests, the packages of the configuration folder), mcp-gateway.docker.internal (the MCP gateway of `sbx`), and the Ubuntu and Docker package hosts during the start.

### Verdict

Docker Sandboxes fits the design of `oc-sub`: one server per project sandbox, reached through a published port, with a key that the agent cannot read. Three things need a decision or code: the global network policy, the end of the unsandboxed host server, and the key check of `oc-sub run`.
