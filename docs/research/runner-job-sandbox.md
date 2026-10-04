---
checked: 2026-10-04
recheck: each new sbx release
decisions:
  - "idfix step 32: the runner process of each GitHub Actions job operates inside one sbx microVM"
  - "idfix step 32: the user gh-runner logs in to sbx with a Docker PAT from a root-only credential"
  - "idfix step 32: the Claude OAuth token goes into the job VM as an environment variable of sbx exec"
  - "meta step 12, decision 17: one Claude Max token in /etc/credstore/claude-oauth.token for all runner jobs"
---

# A sandbox for each runner job

This report gives the facts for step 32 of `docs/PLAN.md` (sub-step 32a). The goal: each GitHub Actions job of the self-hosted runner on this machine operates in its own Docker Sandboxes (`sbx`) microVM. idfix starts the microVM. Claude Code is the agent in the job.

The base is option (a) of arch-helper fix 50: the Linux user `gh-runner`, rootless Docker, and one just-in-time (JIT) runner for each job. A JIT runner is a runner registration that is good for one job only. Two gaps of option (a) are the reason for this step. Docker images stay between jobs, and a job has full network access.

Scope of the reading: the arch-helper branch `feature/12f-runner` (worktree `.worktrees/12f-runner`, commit 85e3ffd), `docs/gh-runner.md`, `docs/research/self-hosted-runner.md`, `fixes/50-gh-runner.sh`, and `lib/gh-runner/`. Also `docs/research/claude-in-sandbox.md`, `src/sandbox.ts`, the sbx lessons in meta, and the meta report `autonomous-dev-on-github.md`.

No sandbox was made, no login was done, and no key file was read. The local commands were `sbx --help` and its subcommands, `sbx version`, `sbx settings list`, `ls`, `stat`, `id`, and `ps`. The installed version is `sbx` v0.45.1. The latest stable release is v0.46.0 of 2026-09-28.

Marks: "(read)" means that this research read the page or the issue. "(search excerpt)" means that only a search result was read. "(local)" means a measurement on this machine. "[guess]" marks a statement without a source. No tool can guarantee ASD-STE100 compliance. The strict vocabulary of this report comes from a lossy index, and full compliance needs the official dictionary (free at asd-ste100.org).

## Short answers

1. Login: `sbx` has a headless login. The command is `sbx login --username <docker-id> --password-stdin`, with a Docker personal access token (PAT) on stdin. Each Linux user has its own `sbx` daemon and its own credential store. A root-only file can feed the login through a systemd credential.
2. Lifecycle: a create of a cached image took 6 s, and the first create took 65 s. `sbx rm --force` removes the VM, its Docker storage, and its sandbox-scoped secrets.
3. Network: the daemon of `gh-runner` can start with the global policy `deny-all`. Each job sandbox then gets its own allow list.
4. Claude token: with sbx v0.45.1, the token must go into the VM as an environment variable. The secret proxy of sbx does not inject a `claude setup-token` token for `api.anthropic.com`. A systemd credential keeps the token in memory on the host for the life of one job unit.
5. `/dev/kvm`: the device has mode 0666 on this machine, so `gh-runner` needs no group. But the unit `gh-runner@.service` sets `PrivateDevices=yes`, and that setting hides `/dev/kvm`.
6. Prior art: actuated and fireactions put each job in a Firecracker microVM. Neither fits a personal account on WSL2 without changes. No established tool makes option (c) unnecessary.

Recommendation: put the whole runner process into the microVM, not only the Claude step. Section 7 gives the design, and section 9 gives the changes to fix 50.

## 1. Login of sbx for a second Linux user

### 1.1 Facts

1. `sbx login --help` gives the flags `--username string` ("Docker username for non-interactive login") and `--password-stdin` ("Read password or access token from stdin"). (local)
2. The Docker page "Run sandboxes in CI" says: "echo "$DOCKER_PAT" | sbx login --username <your-docker-id> --password-stdin". The PAT needs "at least Read scope". Source: [docs.docker.com/ai/sandboxes/workflows/automation](https://docs.docker.com/ai/sandboxes/workflows/automation) (read).
3. The FAQ says that a login is mandatory: "Signing in gives each sandbox a verified identity." Source: [docs.docker.com/ai/sandboxes/faq](https://docs.docker.com/ai/sandboxes/faq/) (read).
4. The daemon is a process of the user. On this machine, `sbx daemon start` operates as `toka`. Its socket is `~/.local/state/sandboxes/sandboxes/sandboxd/sandboxd.sock` with mode 0600. (local, `ps` and `find`)
5. Release v0.43.0: "The local daemon now verifies connecting operating-system users on Unix sockets". Release v0.46.0: "Starting a second daemon against a state directory already in use fails with an error". Source: `gh release view` of [docker/sbx-releases](https://github.com/docker/sbx-releases) (read). Thus each Linux user has a separate daemon, state, and secret store. A separate policy store for each user is a [guess] from the state folder. Examine it in the spike.
6. Credentials on Linux go to the Secret Service of a desktop keyring. If no Secret Service operates, for example on "headless servers and some WSL setups", sbx "falls back to a file". The file is in `~/.config/com.docker.sandboxes`, mode 0700. Source: [Manage credentials](https://docs.docker.com/ai/sandboxes/configuration/credentials/) (read).
7. This machine has no Secret Service. `toka` has the folders `~/.config/com.docker.sandboxes` and `~/.config/com.docker.sandboxes-auth`, both mode 0700. The login of `toka` works. Thus the file fallback works on this host. (local)
8. Known problems with headless login: issue [#186](https://github.com/docker/sbx-releases/issues/186) (Ubuntu over SSH, v0.31.1, a keyring prompt stops the login). Also issue [#327](https://github.com/docker/sbx-releases/issues/327) (NixOS, "failed to open secretservice session") and issue [#180](https://github.com/docker/sbx-releases/issues/180) (WSL, v0.31.0, search excerpt). The first two are read. If a D-Bus session bus exists but has no keyring, these problems can occur. The user `gh-runner` with linger gets a user bus at `/run/user/<uid>/bus` [guess: the fallback then still applies, as for `toka`, because `toka` also has a user bus].
9. Issue [#406](https://github.com/docker/sbx-releases/issues/406) (open, read): an expired session starts a device-code prompt and does not return an error. A script that closes stdin gets an error, but that behavior is not documented.
10. Issue [#609](https://github.com/docker/sbx-releases/issues/609) (open, read): each command refreshes the Docker session. If `login.docker.com` is not available, sbx does no work.
11. Issue [#471](https://github.com/docker/sbx-releases/issues/471) (closed, read): in v0.39.0, the first daemon start showed an interactive `sbx setup` import screen, and a script stopped for 30 minutes.

### 1.2 How a root-only file feeds the login

The Docker PAT can stay in `/etc/credstore/gh-runner-docker.pat`, mode 0600, owner root. A oneshot system unit with `User=gh-runner` and `LoadCredential=docker-pat:/etc/credstore/gh-runner-docker.pat` reads it. systemd puts the file in `$CREDENTIALS_DIRECTORY`. The man page says: "The data is only accessible to the user associated with the unit ... (as well as the superuser)". If possible, "non-swappable memory" holds the data. Source: `man systemd.exec`, `LoadCredential=` (local, read).

The unit then does `sbx login --username <docker-id> --password-stdin < "$CREDENTIALS_DIRECTORY/docker-pat"`.

After the login, the Docker session lives in `/var/lib/gh-runner/.config/com.docker.sandboxes`. The user `gh-runner` can read that folder. Thus the design must not operate job code on the host as `gh-runner` (section 7).

## 2. Lifecycle of one sandbox for one job

### 2.1 Facts

1. Create: `sbx create --name N [flags] AGENT [PATH...]`. Without a path, the sandbox has no workspace mount. The flags include `--cpus`, `--memory`, `-e`, `--deny-network`, `-t` (template image), and `--pull`. The default of `--memory` is "50% of host memory, clamped to 512 MiB–32 GiB". The flag `-e` takes `KEY=VALUE` or "a bare KEY to take the value from the current environment". (local, `sbx create --help`)
2. Exec: `sbx exec [flags] SANDBOX COMMAND`. "Flags match the behavior of "docker exec"". The flags include `-e`, `--env-file`, `-u`, and `-w`. Detached mode is not supported. (local)
3. Remove: `sbx rm` "stops them, removes their containers, cleans up any Git worktrees, deletes sandbox state, and deletes secrets scoped to each removed sandbox". Without a terminal, `--force` is necessary. (local, and lesson `sbx-clone-mode-fails-silently`)
4. `sbx prune` removes all stopped sandboxes. `--filter until=` limits the set. (local)
5. Each sandbox has its own Docker Engine. `/var/lib/docker` in the VM is a volume of 10 GiB (configuration key `sandbox.disk.dockerVolume`). (local, `sbx settings list`, and [architecture](https://docs.docker.com/ai/sandboxes/architecture/), read)
6. The docs say: "Use `sbx rm` to delete the sandbox, its VM, and all of its contents."
   The host keeps only the direct workspace mounts and the shared skills store. Source: [architecture](https://docs.docker.com/ai/sandboxes/architecture/) and [defaults](https://docs.docker.com/ai/sandboxes/security/defaults/) (read).
7. Time: the first `sbx create` took 65 s, mostly for a 1.1 GB image. A start of a stopped sandbox took about 3 s. A `sbx create --clone` with a cached image took 6 s. Sources: `docs/research/sandbox.md` section 7 and `docs/research/run-isolation.md` (measured on this host, 2026-09-29 and 2026-09-30).
8. Templates: `sbx template save SANDBOX TAG` saves a snapshot as an image. `sbx create -t TAG --pull never` uses it. (local)
9. Disk on this host: the containerd store of `toka` uses 12 GB for 5 project sandboxes and their images. The host has 16 CPUs, 30 GiB of memory, and 889 GB of free disk. (local)
10. Issue [#528](https://github.com/docker/sbx-releases/issues/528) (closed, read): in v0.39.0, each create authenticated again with Docker Hub, and parallel creates waited for each other. Docker marked it as fixed in a later release.

### 2.2 How to make sure that nothing stays

1. Give each sandbox a name with the instance and the runner ID, for example `job-grata-1-<runner-id>`.
2. Remove the sandbox with `sbx rm --force` at the end of the job, in a trap of the job script.
3. Remove it again in `ExecStopPost=` of the unit. A crash of the job script then also removes it.
4. At each start of the unit, remove all sandboxes whose name starts with `job-<instance>-`. A reboot then leaves nothing.
5. Make sure that `sbx ls` does not show the name after the removal.

Things that stay on purpose: the template image in the containerd store of `gh-runner`, and the global policy. A job cannot write to either, because the job operates inside the VM [guess: to examine in the spike, `sbx template ls` after a job].

Open point for the spike: does `sbx rm` also remove the policy rules of the sandbox? Do `sbx policy ls` after a removal.

## 3. Network policy of sbx

### 3.1 Facts

1. `sbx policy init <allow-all|balanced|deny-all>` sets the global policy. Rules for one sandbox, also the rules of agent kits, "apply on top for individual sandboxes". `sbx daemon start --policy deny-all` sets it at the first start. (local)
2. `sbx policy allow network [--sandbox SANDBOX] RESOURCES` adds an allow rule. Resources are hosts, wildcards (`*.example.com`, `**.example.com`), IPs, and CIDRs, with an optional port. `--method` and `--path` make an HTTP rule. (local)
3. "If a resource matches both an allow and a deny rule, the deny rule takes precedence." (local, `sbx policy allow --help`)
4. The default security page: "blocks all outbound TCP traffic unless explicitly allowed". UDP is off and ICMP is blocked. The host Docker daemon and the host files outside the mounts are always blocked. Source: [defaults](https://docs.docker.com/ai/sandboxes/security/defaults/) (read).
5. The policy of `toka` has the global rule `default-allow-all`. Because a deny rule always wins, a sandbox-scoped allow list was not possible under it. Source: `docs/research/sandbox.md` section 7 (measured 2026-09-29).
6. The proxy of sbx changes `host.docker.internal` to `localhost`. idfix thus denies `host.docker.internal`, `localhost`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, and `192.168.0.0/16` (`NETWORK_DENY_HOSTS` in `src/sandbox.ts`).

### 3.2 Policy for a job sandbox

The daemon of `gh-runner` is separate from the daemon of `toka` (section 1.1, fact 5). Thus its global policy can be `deny-all` and not touch the project sandboxes of `toka`. Each job sandbox then gets these allow rules:

| Purpose | Hosts | Source |
|---|---|---|
| Runner to GitHub | `github.com`, `api.github.com`, `*.actions.githubusercontent.com`, `codeload.github.com`, `results-receiver.actions.githubusercontent.com`, `*.blob.core.windows.net` | [GitHub runner reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners) (read) |
| Packages of GitHub | `ghcr.io`, `*.pkg.github.com`, `pkg-containers.githubusercontent.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com` | same page, release assets [guess for the last two names] |
| Claude Code | `api.anthropic.com`, `platform.claude.com` (OAuth refresh), `downloads.claude.ai` and `registry.npmjs.org` (install) | [Claude Code network configuration](https://code.claude.com/docs/en/network-config) (read) |
| Package registries of the projects | `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, the mise sources, Docker Hub (`registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com`) | [guess] for the list. Take the real list from `sbx policy log` in the spike. |
| Deny | the `NETWORK_DENY_HOSTS` of idfix | `src/sandbox.ts` |

Set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` in the job. Then the Datadog telemetry hosts are not necessary (same Claude Code page).

Limits of the allow list:

1. `*.blob.core.windows.net` covers all Azure storage accounts, also those of an attacker. The runner needs it for logs, artifacts, and the cache.
2. `github.com` is open for `git push`. A prompt injection can push data to a repository of the attacker with a PAT of the attacker. An HTTP rule with `--path '/thoka/**'` can make this smaller [guess: the proxy terminates TLS for credential injection, so path rules can apply to HTTPS. Do a test in the spike].
3. Thus the policy makes data exfiltration harder, but it does not prevent it.

## 4. The Claude token for exactly one job

### 4.1 Condition

Decision 17 of the meta plan, step 12: one Claude Max token for all projects. It lives in `/etc/credstore/claude-oauth.token`, which only root reads. Each job gets it as `CLAUDE_CODE_OAUTH_TOKEN`. arch-helper fix 50 adds the file. This section does not ask whether a token is necessary. It asks how one job gets the token and how the job loses it after the job.

### 4.2 Facts about the token

1. `claude setup-token` makes "a one-year OAuth token". The token "can only make model requests". It cannot start Remote Control sessions or get claude.ai connectors. Source: [Claude Code authentication](https://code.claude.com/docs/en/authentication) (read).
2. Precedence: `ANTHROPIC_AUTH_TOKEN` (sent as `Authorization: Bearer`), then `ANTHROPIC_API_KEY` (sent as `X-Api-Key`), then `apiKeyHelper`, then `CLAUDE_CODE_OAUTH_TOKEN`. Bare mode does not read `CLAUDE_CODE_OAUTH_TOKEN`. Same source.
3. Revocation: `claude setup-token` has no list or revoke command. The token shows in the claude.ai account page for Claude Code, with a revoke button. Sources: issues [#48373](https://github.com/anthropics/claude-code/issues/48373) and [#57400](https://github.com/anthropics/claude-code/issues/57400) of anthropics/claude-code (search excerpt).
4. Terms: the GitHub Actions page of Claude Code names `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` as a normal setup for Pro and Max. The meta report reads this as the "explicit permission" of the Consumer Terms. The limit "ordinary, individual usage" has no definition. Source: `~/dv/meta/docs/research/autonomous-dev-on-github.md` section 1. This report links to it and does not do the analysis again.

### 4.3 Facts about the secret proxy of sbx

1. `sbx secret set --oauth`: "Start OAuth flow and store OAuth tokens (openai/global only)". For Anthropic, a local OAuth secret comes only from a `/login` of Claude Code in a sandbox, and it is global. (local, `sbx secret set --help` and `sbx secret import --help`)
2. A custom secret puts a placeholder into the sandbox. The proxy changes the placeholder into the real value in the request headers. (local, `sbx secret set-custom --help`)
3. Since v0.43.0, a custom secret for `CLAUDE_CODE_OAUTH_TOKEN` and `api.anthropic.com` no longer works. Claude Code reports "Not logged in". The cause is the change "a client-supplied credential the proxy did not issue is not forwarded to managed provider hosts". Sources: issue [#601](https://github.com/docker/sbx-releases/issues/601) (open), issue [#11](https://github.com/docker/sbx-releases/issues/11) (open), release notes v0.43.0. All read.
4. A sandbox-scoped `anthropic` secret goes out as `x-api-key`. Thus a subscription token in that secret fails with 401. While a global Anthropic OAuth secret exists, the proxy writes it over the token of each sandbox. Source: issue [#144](https://github.com/docker/sbx-releases/issues/144), comment for v0.46.0 (read).
5. A kit (v3) can declare a credential with `inject: domain, header, format: "Bearer %s"`. Issue [#490](https://github.com/docker/sbx-releases/issues/490) (closed, read) reports that `proxyManaged: true` did not work with a service of a kit in v0.39.0. Issue [#615](https://github.com/docker/sbx-releases/issues/615) (closed, read) reports that an apiKey service on a host stops the OAuth injection on the same host. Sources also: [kit spec reference](https://docs.docker.com/ai/sandboxes/customize/kit-reference/) (search excerpt).

### 4.4 Comparison

The three ways are not on the same level. The systemd credential moves the token from the root file to the job unit on the host. The other two move it from the host into the VM.

| Way | Where the token is during the job | After the job | Works with sbx v0.45.1 | What a prompt injection in the job can do |
|---|---|---|---|---|
| A. `sbx exec -e CLAUDE_CODE_OAUTH_TOKEN` (bare name, value from the environment of the job script) | In the environment of the runner process in the VM, and in all its child processes. The agent has sudo in the VM, so it can read the value. | `sbx rm` removes the VM and the value. | Yes. If no global Anthropic secret exists, `-e CLAUDE_CODE_OAUTH_TOKEN=<token>` works (issue #144). | Read the token and send it to an allowed host (section 3.2). Then use the subscription for model requests from anywhere until the user revokes the token, for up to one year. |
| B. Secret proxy with a placeholder | On the host only. The VM sees a placeholder. | If the proxy secret is sandbox-scoped, `sbx rm` removes it. | No. Custom secrets for `api.anthropic.com` fail since v0.43.0 (issue #601). Sandbox-scoped `anthropic` secrets go out as `x-api-key` (issue #144). A kit credential is not tested. | Use the subscription through the proxy during the job only. It cannot take the token out of the VM. |
| C. systemd credential, `LoadCredential=claude-oauth.token` (file `/etc/credstore/claude-oauth.token`) in `gh-runner@.service` | In `$CREDENTIALS_DIRECTORY` of that unit, in memory, readable by `gh-runner` and root. | At the stop of the unit, systemd removes it. | Yes (systemd feature). It is a host step, so it combines with A or B. | Nothing more than A or B, because the job code is in the VM. A VM escape as `gh-runner` can read it during the job. |

Result: use C together with A. This is the only way that works with sbx v0.45.1. If sbx can inject a `setup-token` token for `api.anthropic.com` in a later release, change to C together with B. Watch issues #11 and #601.

Rules for A:

1. Pass the name only: `sbx exec -e CLAUDE_CODE_OAUTH_TOKEN ...`. Do not write `-e NAME=value`. All users can read the command line of a process in `/proc`. The `ps` output of this host shows that idfix passes its configuration as `-e NAME=value` today, which is correct only for values that are not secret. (local)
2. Do not make a global Anthropic secret in the store of `gh-runner`. Do not do `/login` in a job sandbox. Otherwise the proxy writes over the token (issue #144).
3. Use the `shell` agent, not the `claude` agent. The `claude` kit puts `"apiKeyHelper": "echo proxy-managed"` into the configuration file `~/.claude/settings.json` in some cases. That helper ranks above `CLAUDE_CODE_OAUTH_TOKEN`. Sources: issues [#344](https://github.com/docker/sbx-releases/issues/344) and [#638](https://github.com/docker/sbx-releases/issues/638) (read).

What a prompt injection can still do in all ways:

1. Use the Max subscription during the job, also for work outside the task. This uses the 5-hour and weekly limits of the user.
2. With way A, copy the token. The token then works outside the job for model requests until the user revokes it. It cannot change the account and cannot get claude.ai connectors (section 4.2, fact 1).
3. Use the `GITHUB_TOKEN` of the job and the repository data in the limits of the workflow permissions.

If way B works in a later release, it removes item 2 only.

## 5. Access to /dev/kvm for gh-runner

1. `/dev/kvm` on this host: mode `crw-rw-rw-`, owner root, group ID 109. GID 109 has no name. The group `kvm` exists with GID 990. (local, `stat` and `getent`)
2. Thus each local user can open `/dev/kvm` today. `gh-runner` needs no group change.
3. The mode comes from the udev default rule (`MODE="0666"` on Arch). On 2026-09-30, the device once came back with mode 0660, and every sbx start failed. Sources: lesson `sbx-start-fails-check-diagnose-first`, `docs/research/wsl-kvm-access.md`.
4. Fix 50 lists `kvm` in `BAD_GROUPS` and removes `gh-runner` from it. If the device mode goes back to 0660, `gh-runner` loses KVM, and all job sandboxes fail. Access to `/dev/kvm` lets a user start VMs. It does not give root [guess based on the KVM device model, not read in a source].
5. The unit `gh-runner@.service` sets `PrivateDevices=yes`. The man page: the new `/dev` has "no physical devices" and the unit gets `DevicePolicy=closed`. Thus a sbx daemon that starts inside that unit cannot open `/dev/kvm`. Source: `man systemd.exec` (local, read).
6. If no daemon operates, the `sbx` client starts one ("starting it if necessary", `sbx settings --help`). A daemon that starts in the job unit also dies with `KillMode=control-group` at the end of the job. The daemon must thus have its own unit.

Result: the sbx daemon of `gh-runner` gets its own unit without `PrivateDevices=yes`. Keep mode 0666 through udev, as in `docs/research/wsl-kvm-access.md`, option A. Remove `kvm` from `BAD_GROUPS`, or add a check that `gh-runner` can open `/dev/kvm`.

## 6. How others put a job into a microVM

| Tool | What it does | Fit for this machine | Source |
|---|---|---|---|
| actuated | Each job in a Firecracker microVM on servers of the customer. The control plane is a paid service. | Needs bare metal with KVM and nested virtualization. Targets teams and organizations. Paid. | [actuated.com](https://actuated.com/) (read) |
| hostinger/fireactions (Apache-2.0, 192 stars, pushed 2026-09-28) | A pool of Firecracker microVMs. "Each virtual machine is created from scratch and destroyed after the job is finished." About 20 s to start a runner. | Needs root, containerd, CNI plugins, and a GitHub App "installed on your target organization". A personal account has no organization runners. Firecracker on WSL2 is not proven. | [fireactions.io](https://fireactions.io/latest/) (read), `docs/user-guide/installation.md` and `overview.md` in the repository (read) |
| cloudbase/garm (407 stars, pushed 2026-09-29) | Runner manager with providers for LXD, Incus, Kubernetes, and clouds. | A VM per job through LXD or Incus. No credential proxy and no egress policy of its own. A new stack on this host. | [github.com/cloudbase/garm](https://github.com/cloudbase/garm) (read) |
| actions/actions-runner-controller with Kata Containers | Kubernetes controller. Kata gives a VM per pod. | Kubernetes is too large for one machine [guess]. | gh api (local) |
| actions/scaleset (194 stars) | Go client for scale sets. Its example starts one Docker container per job. | Gives the JIT plumbing, not a VM. | meta report section 5 |
| Docker Sandboxes in CI | Docker documents `sbx` in CI: login with a PAT, create, run, `rm --force`. | Fits. sbx already operates on this host. Issue [#425](https://github.com/docker/sbx-releases/issues/425) (open, read) says that nested KVM in cloud CI VMs is not supported. That does not apply here, because WSL2 gives KVM to this host. | [automation page](https://docs.docker.com/ai/sandboxes/workflows/automation) (read) |
| skills.sh | Searches "docker sandboxes sbx", "self-hosted runner", "firecracker runner", "sbx". Hits with 1 to 21 installs, for example `slurpyb/sbx-agent` and `shelajev/sbx-skill`. | Nothing to adopt. | skills.sh search API (read) |

Result: the established tools agree on the pattern. The runner process itself operates in a fresh VM for each job, and the host only starts and removes VMs. No established tool supports repository runners of a personal account, an egress allow list, and a credential proxy on WSL2. idfix with sbx gives the same pattern with a tool that already operates here.

## 7. Recommendation for the design

### 7.1 The runner in the VM

Put the whole runner process into the job sandbox, not only Claude Code. Reasons:

1. The steps of a workflow (checkout, `run:` lines, other actions) then operate in the VM. With only Claude in the VM, these steps operate on the host as `gh-runner`. Then they can read the Docker session of sbx (section 1.2).
2. Docker images of a job stay in the Docker Engine of that VM, and `sbx rm` removes them. This closes gap 3 of `docs/gh-runner.md`.
3. The network policy of sbx applies to all steps. This makes gap 4 smaller (section 3.2).
4. `claude-code-action` operates in the VM as it is. The VM has sudo and apt, so the "best-effort" isolation step of the action can install `bubblewrap`.
5. This is the pattern of actuated and fireactions (section 6).

Rootless Docker for `gh-runner` is then not necessary. The user boundary stays as a second layer: a VM escape gets `gh-runner`, not `toka`.

### 7.2 Steps of one job

1. Root (`prepare`, as today) gets the JIT configuration from GitHub with the root-only PAT.
2. systemd gives the unit the Claude token as a credential (`LoadCredential=`).
3. The job script (idfix, as `gh-runner`) removes old sandboxes of this instance (section 2.2).
4. The job script creates the sandbox: `sbx create --name job-<inst>-<id> --cpus 4 --memory 8g shell <relative path of /opt/actions-runner>:ro <relative path of /srv/meta-agents>:ro`. sbx v0.45.1 accepts a read-only mount only with a relative path, so the script operates from `/` (`src/sandbox.ts`).
5. The job script adds the allow rules and the deny rules of section 3.2 to the sandbox.
6. The job script puts the JIT configuration and the token into its own environment and starts `sbx exec -e ACTIONS_RUNNER_INPUT_JITCONFIG -e CLAUDE_CODE_OAUTH_TOKEN -e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC job-<inst>-<id> bash -c 'cp -a <runner mount> ~/runner && cd ~/runner && exec ./run.sh'`.
7. The runner does one job and stops.
8. The job script does `sbx rm --force job-<inst>-<id>`. `ExecStopPost=` does it again.

First version: the runner comes from the read-only mount and is copied in the VM. Later version: a template image with the runner and its libraries, made by the daily update timer with `sbx template save`. Then the create does not copy the runner and does not install libraries.

### 7.3 The daemon of gh-runner

1. A system unit `gh-runner-sbx.service` with `User=gh-runner`, `HOME=/var/lib/gh-runner`, and `ExecStart=sbx daemon start --policy deny-all` (foreground). No `PrivateDevices=yes`.
2. A oneshot unit `gh-runner-sbx-login.service` with `LoadCredential=docker-pat:...` that does the login of section 1.2. Order it before the daemon unit is used.
3. The job unit gets `Requires=` and `After=` on both units.
4. Close stdin of each sbx call, so that a needed login gives an error and not a device-code prompt (issue #406).

## 8. Open questions for the user

1. Docker account: is it permitted to use a Docker PAT of the account of the user for `gh-runner`? It needs Read scope. Value analysis: a separate Docker account gives a clean identity and a separate rate limit, but costs one more account to keep. The same account is simpler, but a leak of the PAT gives read access to the Docker Hub repositories of the user.
2. Network policy strictness: deny-all with an allow list for each project, or `balanced` for all jobs? deny-all serves the value "blast radius small". If a job needs a new registry, it costs time. `balanced` serves "deliver first" and leaves more exfiltration paths open.
3. Token way B: if sbx supports a proxy-managed `setup-token` in a later release, change from way A to way B? It removes the copy of the token, but it adds a dependency on a feature that changed twice in 2026.
4. A second option for the token is a global Anthropic OAuth secret in the store of `gh-runner`. One interactive `/login` in a job sandbox makes it. The proxy then injects the token, and the VM never sees it. But it is a different credential from decision 17, and it needs the `claude` kit, which has the `apiKeyHelper` problem. Is decision 17 open for that test?
5. Resources: how many parallel jobs, and how much CPU and memory for each? The default memory of sbx is 50% of the host for each sandbox.

## 9. Changes that fix 50 in arch-helper needs

These changes are for the supervisor, who owns arch-helper. They come after the spike of step 32c.

1. Remove `kvm` from `BAD_GROUPS`, or keep it and add to `isolation` a test that `gh-runner` can open `/dev/kvm` (`expect_yes "open /dev/kvm" test -r /dev/kvm -a -w /dev/kvm`).
2. Add to `apply` the install of `sbx` for `gh-runner` at the same version as `mise.toml` of idfix (v0.45.1). A root-owned binary in `/usr/local/lib/gh-runner/sbx/` is one way [guess: sbx needs its companion binaries, such as `containerd-shim-nerdbox-v1`, in the same folder, as in the mise install].
3. Add `set-docker-token`, like `set-token`. It reads the Docker PAT into `/etc/credstore/gh-runner-docker.pat`, mode 0600, owner root.
4. Add the units `gh-runner-sbx-login.service` and `gh-runner-sbx.service` (section 7.3).
5. In `gh-runner@.service`:
   - Keep `PrivateDevices=yes`, because the daemon has its own unit. If the daemon stays in the job unit, remove the setting.
   - Done in arch-helper `alpha` 0856b95: `LoadCredential=claude-oauth.token`, written by `set-claude-token`. `run-job` exports `CLAUDE_CODE_OAUTH_TOKEN` before `run.sh`. The job command passes it on with `sbx exec -e CLAUDE_CODE_OAUTH_TOKEN`.
   - Add `ReadWritePaths=/var/lib/gh-runner`, because the sbx client writes logs and locks below `~/.local/state/sandboxes` and `~/.config/sandboxes`.
   - Add `Requires=gh-runner-sbx.service` and `After=gh-runner-sbx.service`.
   - Remove `Environment=DOCKER_HOST=...`.
6. Change `run-job`: do not start `./run.sh` on the host. Call the idfix job command of section 7.2. Remove the removal of containers of the rootless Docker. Keep the JIT data in the environment.
7. Change `prepare`: the copy of the runner and the fresh `HOME` are not necessary on the host, because the VM is fresh. Keep the JIT request. The shared rules reach the VM through the read-only mount of `/srv/meta-agents`.
8. Change `cleanup`: also do `sbx rm --force` for each sandbox `job-<instance>-*`.
9. Remove rootless Docker: the user unit `docker-rootless.service`, `dockerd-rootless.sh`, the packages `rootlesskit` and `slirp4netns`, and the subordinate IDs. Remove the rootless Docker tests from `isolation`. Do this only after the spike shows that jobs with Docker work in the VM.
10. Add to `isolation`: the daemon of `gh-runner` answers (`sbx ls`), its global policy is deny-all (`sbx policy ls`), and `gh-runner` cannot read `/etc/credstore/gh-runner-docker.pat`.
11. Update `docs/gh-runner.md`: the design, gaps 3, 4, 6, and 7, and the new setup steps.

## 10. Items for the spike (step 32c)

1. As `gh-runner`: the PAT login without a keyring, and the daemon start without the interactive `sbx setup` screen.
2. The daemon in a system unit with `User=gh-runner`. Does it need `XDG_RUNTIME_DIR` or more devices than `/dev/kvm`?
3. `sbx exec -e NAME` with the bare name takes the value from the environment, as with `sbx create`.
4. The JIT runner in the `shell` template: the missing libraries of the runner, and the time from create to the first job step.
5. `claude -p` in the VM with `CLAUDE_CODE_OAUTH_TOKEN`: it works, and `sbx policy log` shows the hosts.
6. `claude-code-action` in the VM gets the token from the environment of the runner process.
7. `sbx rm` removes the per-sandbox policy rules.
8. An HTTP path rule for `github.com` works on HTTPS.

## 11. Search log

- Local sbx commands: `sbx version`, `sbx --help`, and `sbx settings list`.
- Local help pages of sbx: `login`, `daemon`, `daemon start`, `create`, `run`, `exec`, `rm`, `prune`, and `reset`.
- More local help pages: `secret`, `secret set`, `secret set-custom`, `secret import`, `template`, and `template save`.
- Local help pages for policy: `policy`, `policy allow`, `policy allow network`, `policy init`, `policy reset`, and `policy profile`.
- Other local commands: `stat /dev/kvm`, `getent group kvm`, `id gh-runner`, `ps`, and `man systemd.exec`. The user `gh-runner` does not exist yet.
- Local file list: `find` for the names and modes in the sbx folders of `toka`. No file content.
- Docker docs (read): sandboxes index, automation, credentials, FAQ, Claude Code agent, security, defaults, architecture.
- GitHub issues of docker/sbx-releases (read with `gh`): #11, #144, #180 (search hit only), #186, #327, #344, #406, #425, #471, #490, #528, #601, #609, #615, #638. Release notes v0.43.0, v0.45.0, v0.46.0.
- Anthropic (read): Claude Code authentication, network configuration. Search excerpt: issues #48373 and #57400 of anthropics/claude-code.
- GitHub docs (read): self-hosted runner reference, domain list.
- Prior art (read): actuated.com, fireactions.io and its repository docs, cloudbase/garm. gh api for stars and dates.
- skills.sh API: four searches, no skill to adopt.
- Meta: lessons `sbx-*` and `sandbox-*`, research index, `autonomous-dev-on-github.md` sections 1 and 5.
