# Deploy access: how the orchestrator should reach a deployment machine

Research date: 2026-09-30. Follow-up to [sandbox.md](sandbox.md) and [run-isolation.md](run-isolation.md).

Question: a main thread (Claude Code) plans and reviews; subagents work in sandboxes; nothing reaches the real repository until a trusted side pulls and reviews it (`git fetch`, see run-isolation.md). What is the same boundary for a deployment machine — a VPS with Docker or systemd services? How can the orchestrator (or an agent it starts) deploy, read logs, restart services, and fix problems without a blast radius that covers the whole machine or its secrets?

Facts carry a source (URL). Statements marked **[guess]** are judgment. Registry searches: GitHub `gh search repos "ssh mcp server"` (10 results, 6 with any substance) and `"kubernetes mcp server"` (5 results) on 2026-09-30; web searches listed in Section 8.

## 0. Short answers

1. **The strongest prior art for the exact code-boundary principle is pull-based deployment: the agent edits a git repo, the server pulls it.** The server never needs an inbound path that the agent can use. Established form: Argo CD / Flux (Kubernetes), or for a small Docker host a systemd timer that pulls a repo and runs `docker compose up -d --wait`. One fresh project, docker-git-deploy, states the principle plainly: "The agent edits a **deployment repo** (pure config)... No SSH or push access to the host is required" and "the agent helps troubleshoot but never needs access to the server itself" (https://github.com/linksawakening/docker-git-deploy).
2. **Time-limited interactive access is a solved problem with SSH certificates** (step-ca: default user cert validity 16 h, configurable per provisioner — https://smallstep.com/docs/tutorials/ssh-certificate-login/), with **Tailscale SSH check mode** (re-authentication with a `checkPeriod`, minimum 1 minute — https://tailscale.com/docs/features/tailscale-ssh), and with **Teleport Access Requests** (approval workflow + TTL; approval workflow is Enterprise — https://goteleport.com/docs/identity-governance/access-requests/). A plain systemd timer that removes a key is the zero-infrastructure fallback.
3. **Operations split into four levels** (observe / deploy / restart / break-glass); only observe and restart need to be available to an agent directly, and restart is the highest level an agent should get without a human in the loop. Deploy reaches the machine only through the pull pipeline; break-glass is human-only.
4. **For the declarative-spec requirement:** NixOS gives the most complete spec and atomic rollback but the steepest effort; Docker Compose + a pull timer + systemd units is the pragmatic spec for a one-person Docker VPS; Ansible is convergent, not congruent — "If you delete Nginx from the YAML file, and deploy, Nginx is still running" (https://discourse.nixos.org/t/nixos-vs-ansible/16757).

## 1. Criteria

From the Values of the global rules plus the brief:

- C1 **Small blast radius.** A wrong or hostile action covers one service, not the machine, its secrets, or other servers.
- C2 **Secrets out of reach.** No agent can read deployment secrets; injection happens at the last trusted step (the same principle as the `sbx` credential proxy, sandbox.md section 7).
- C3 **Audited and reversible.** Every change lands in git history or a log, and undo is a mechanical step (revert, rollback, re-run).
- C4 **Low effort for one person.** Setup and operation for one person and a few small servers; no 24/7 extra service to babysit.
- C5 **Pull crosses the boundary.** The agent proposes; a trusted side pulls. The agent gets no credential that lets it push into the machine.
- C6 **Time-windowed access.** Any interactive access to the machine expires by itself; who approves the window and how the approval is logged is defined.
- C7 **Declarative spec.** The whole server is described as code and rebuildable; drift is detectable, secrets excluded from the repo.

## 2. Access patterns and their prior art

### 2.1 Pull-based GitOps (timer + `docker compose up`)

The server runs a systemd timer (or a small daemon) that pulls a deployment repo and reconciles. Established at cluster scale by **Argo CD** and **Flux** (pull from git, drift detection, sync status); for a single Docker host, small tools now do the same: **oar** — "GitOps automation for Docker Compose on a single Docker host... ArgoCD for Docker Compose", with drift detection and deployment history (https://github.com/oar-cd/oar); **compose-sync** — polls a git repo, deploys only changed stacks assigned to the host by hostname (https://github.com/aottr/compose-sync); and docker-git-deploy, which pulls every 5 min, runs `docker compose up -d --wait`, and rolls back if a new version fails to become healthy (https://github.com/linksawakening/docker-git-deploy).

- What the agent can do: edit the deployment repo (commit/PR). What it cannot do: anything on the machine — the host needs only outbound HTTPS and read-only git.
- Secrets: live on the host only (`.env` created by the human; docker-git-deploy: "the deploy is skipped until `.env` exists, and secrets never live in the repo"). Oar can encrypt stored secrets with a key.
- Audit: git history is the audit log; plus deployment records (oar keeps history).
- Undo: `git revert` and the next pull reconciles; docker-git-deploy auto-rolls-back an unhealthy deployment.
- Cost: a timer and a git remote; effectively zero.

### 2.2 Push-based CI deploys with protected environments

**GitHub Actions environments**: "Deployment protection rules require specific conditions to pass before a job referencing the environment can proceed... require a manual approval, delay a job, or restrict the environment to certain branches"; environment secrets "are only available to workflow jobs that reference the environment" and only after approvals pass (https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments). Unapproved jobs fail after 30 days.

- The agent can open the PR and trigger the workflow; the deploy itself runs in CI with a short-lived token. The agent cannot reach environment secrets (they are not visible to PR runs from forks, and require approval otherwise).
- Audit: workflow run history; approvals are recorded per deployment.
- Undo: re-run a previous commit's deploy.
- Cost: free on GitHub; the deploy script lives in the repo.

### 2.3 Short-lived SSH access (certificates)

**step-ca** is an online CA for X.509 and SSH: "Issue short-lived SSH certificates via OAuth OIDC single sign on" (https://smallstep.com/docs/step-ca/). Default user SSH cert validity 16 h; `maxUserSSHCertDuration` configurable per CA/provisioner (https://smallstep.com/docs/step-ca/configuration/). sshd trusts the CA key (`TrustedUserCAKeys`) instead of `authorized_keys`; a cert that expires simply stops working — no revocation story needed for short windows. Vault SSH works the same way (signed certs with TTLs).

- What the holder can do: whatever the cert principals allow, for the cert lifetime. Audit: the CA logs issuance; sshd logs logins. For command-level audit, combine with forced commands (2.5).
- Undo: expiry; nothing to clean up.
- Cost: one `step-ca` process (it must be reachable when windows open) or a small script that signs with a CA key.

### 2.4 Managed access platforms (Teleport, Boundary, Tailscale SSH)

- **Teleport Access Requests**: "request access to a resource or role depending on need. The request can then be approved or denied based on a configurable number of approvers"; duration is bounded by `--session-ttl` and `request.max_duration`; "users cannot approve their own requests" (https://goteleport.com/docs/identity-governance/access-requests/). Approval with reasons is logged. Caveat: the full request workflow (web UI, plugins) is **Enterprise**; Community Edition gets CLI-only requests.
- **HashiCorp Boundary** sits in the same category (brokered, time-boxed sessions to targets).
- **Tailscale SSH check mode**: an `ssh` ACL rule with `action: check` requires re-authentication via the identity provider before connecting; `checkPeriod` ranges from 1 minute to 168 hours, default 12 h (https://tailscale.com/docs/features/tailscale-ssh). Tailscale's own best-practice page recommends it for high-risk connections such as `root` (https://tailscale.com/docs/reference/best-practices/security).

- What the agent can do: connect as allowed for the window. Secrets: none stored on the target beyond the OS. Audit: Teleport records full sessions; Tailscale logs connections. Undo: expiry.
- Cost: Teleport is a service to run (and pay for full workflows); Tailscale is free for personal use and needs no inbound firewall holes — this is its main advantage for a one-person setup.

### 2.5 Restricted SSH (`authorized_keys` forced commands)

`authorized_keys` supports `restrict` (disables pty, forwarding, etc.) and `command="..."` (forced command, overriding the client's request). The standard shape: one low-privilege OS user per service, `restrict,command="/usr/local/bin/deployctl logs"` per key, and a dispatcher script that allows a small verb set (`logs`, `status`, `restart <unit>`, `deploy <commit>`) and logs each invocation. The SSH MCP server `gelse/ssh-mcp` shows the same idea as a gateway: layered command policies, "SSH credentials stay on the gateway, not on every agent's machine", structured JSONL audit of every command (https://github.com/gelse/ssh-mcp). But it also names its own limit: "It does not replace the permissions of the underlying SSH accounts."

- What the agent can do: only the verbs the dispatcher allows. Audit: the dispatcher's log. Undo: service-specific.
- Cost: an afternoon of shell script. Failure mode: the dispatcher becomes a root-shaped tool if it grows; keep it on an unprivileged user and review it like production code.
- The AI-agent writing on SSH MCP servers agrees that string policies are not containment: pySSHForAgents — "this is a safety net, not a sandbox... For a real trust boundary, connect as a dedicated unprivileged user and constrain it with OS permissions and/or sshd `ForceCommand`" (https://github.com/WilliamSmithEdward/pySSHForAgents); the same document lists what must need confirmation (`systemctl stop`, package installs, firewall edits).

### 2.6 Sudo allowlists

`sudoers` can allow one user exactly named commands (`NOPASSWD: /usr/bin/systemctl restart app.service`). Good as the enforcement layer *under* a restricted dispatcher or the deploy pipeline; weak alone (argument injection, wildcard pitfalls, shell escapes in allowed editors). Audit: sudo logs every command to the journal. Effort: small. Every serious option here uses some sudo allowlist as the last layer.

### 2.7 Read-only observation off the machine

Ship logs and metrics off the machine (journald remote, vector/promtail to a log host, `uptime-kuma`/healthchecks.io for status). Then "observe" needs **no access to the machine at all**, which is the cheapest way to shrink the blast radius: most agent questions ("is it up?", "what does the log say?") never touch the server.

### 2.8 AI-agent-specific prior art and guardrails

- AWS's pattern guide for agent access: default to read-only, permission boundaries for config-bound scenarios, and differentiation of agent traffic from human traffic; it also warns that agents with bash can bypass any MCP abstraction, so the OS-level controls are the real boundary (https://aws.amazon.com/blogs/security/secure-ai-agent-access-patterns-to-aws-resources-using-model-context-protocol/).
- AgentBound (arXiv 2510.21236): MCP servers wrapped in containers with declared permissions; their motivating attack is an MCP server exfiltrating an SSH key, stopped by filesystem/network scoping (https://arxiv.org/html/2510.21236v1).
- The CSA agentic MCP best practices: tool-level scopes, short token lifetimes, JIT escalation for high-privilege tools, audit logging ≥ 90 days (https://labs.cloudsecurityalliance.org/agentic/agentic-mcp-security-best-practices-v1/).
- Registry check (2026-09-30): SSH MCP servers are numerous but small — best match `classfang/ssh-mcp-server` (915 stars), the gateway-style `gelse/ssh-mcp`, several under 40 stars (immature by the <20-stars / stale-commit rule; most are active but tiny). Kubernetes MCP: `containers/kubernetes-mcp-server` (2138 stars, active). Nothing found that implements a *forwarding* or *pull-based* shape — the mature prior art is policy layers in front of plain SSH.

## 3. Judging the access patterns

| | C1 blast radius | C2 secrets | C3 audit + revert | C4 effort (1 person) | C5 pull crosses boundary | C6 time window |
|---|---|---|---|---|---|---|
| 2.1 Pull GitOps (timer) | **best** — host takes only reviewed commits; no agent-reachable inbound path | host-only `.env`, never in repo | git history is the log; revert = next pull; auto-rollback on unhealthy (docker-git-deploy) | hours | **yes, by construction** | n/a (no standing access) |
| 2.2 CI protected environments | good — deploy runs in CI token | env secrets gated on approval | workflow history + approvals | hours | yes (pipeline) | approval per run |
| 2.3 SSH certs (step-ca) | medium — full shell in window | none needed on target | CA log + sshd log; no action log | medium (a CA service) | no | **yes, built-in TTL** |
| 2.4 Teleport / Tailscale check | medium (Teleport: session recording helps) | none | Teleport records sessions; Tailscale logs connections | Teleport: high (service + Enterprise for workflows); Tailscale: low | no | **yes** (request TTL / checkPeriod) |
| 2.5 Forced commands | good if unprivileged user + verbs | key on host, low-priv | dispatcher log; verbs are reversible scripts | hours (shell work, reviewed) | no (push) | key removal = manual/timer |
| 2.6 Sudo allowlist | medium alone | n/a | journal logs | small | no | no |
| 2.7 Observe off-machine | **none** (no access) | secrets stay away | external log store | small | n/a | n/a |
| 2.8 SSH MCP gateway | weak alone — "does not replace the permissions of the underlying SSH accounts" (gelse/ssh-mcp) | keys on gateway | JSONL audit log | small–medium | no | no |

Known failure modes: pull GitOps — secret *rotation* is manual (human edits `.env`); a broken commit auto-applies (mitigated by health checks + rollback); the compose repo must be treated as production. Forced commands — string allowlists are evadable if they run privileged; dispatcher growth. Teleport — needs an always-on service, workflows paywalled. Tailscale check mode — "always" breaks automation that opens many connections (their own docs warn for Ansible). SSH certs — a CA to run; issuance must be reachable when a window opens.

## 4. The declarative-spec requirement

Ways to describe a whole small server as code:

| | Completeness of spec | Drift detection | Rollback | Secrets out of repo | Effort (1 person) |
|---|---|---|---|---|---|
| **NixOS** (+ colmena / deploy-rs / `nixos-rebuild --target-host`) | near-total: packages, users, firewall, services, secrets in one language; declarative and congruent — removing the config removes the service (discourse: "Nix setups are much closer" to true reproducibility, https://discourse.nixos.org/t/nixos-vs-ansible/16757) | the spec *is* the machine; deviations visible on rebuild | atomic system generations; `nixos-rebuild switch --rollback` | sops-nix or agenix: encrypted files in git, decrypted at activation into `/run/secrets` (NixOS wiki comparison, https://wiki.nixos.org/wiki/Comparison_of_secret_managing_schemes) | **steep**: "I needed a few weeks to get my basic system running" (same discourse thread) |
| **Ansible** | partial/convergent: declarative *tasks*, imperative result — "Ansible doesn't actually provide proper declarative system management" (same thread); removal needs explicit tasks | run-and-see (idempotence checks) | re-run older playbook (no generations) | ansible-vault (encrypted vars in repo) | low–medium; familiar YAML |
| **cloud-init + systemd units** | first-boot only; not a standing spec | none | rebuild the VM | user-data has secrets unless combined with credential files | small but a dead end for standing drift |
| **Docker Compose + pull timer + systemd units** | good for services (the part that changes), poor for the OS around them (packages/users/firewall stay hand-made or in a small Ansible/Nix shell) | compose diff via pull; `docker compose up` reconciles | git revert; auto-rollback on unhealthy (docker-git-deploy, oar) | `.env` on host; compose `secrets:`, or **systemd credentials**: `LoadCredentialEncrypted=` with AES256-GCM bound to TPM2 and/or `/var/lib/systemd/credential.secret`, "ciphertext... cannot be decoded unless access to TPM2/encryption key is available" (https://systemd.io/CREDENTIALS/) | **lowest** |
| **Immutable images (Fedora CoreOS + Ignition)** | very complete (whole OS from a config at first boot) | re-provision to check | re-provision/reboot to previous image | secrets via Ignition at boot, or systemd credentials on the host | medium–high; wrong tool for frequent app changes |

Judgment: for a one-person VPS, the spec split is natural — **the machine spec (small, changes yearly) and the service spec (changes weekly) are different documents.** NixOS is the only option that unifies both at the cost of a steep learning curve and an unasked-for OS migration. Compose + a pull timer covers the weekly-changing part and pairs with either a minimal Ansible/Nix bootstrap for the rest or CoreOS if the user wants the OS itself immutable. Secrets in either case: repo holds only ciphertext (sops-nix/agenix/vault) or nothing (`.env` on host, systemd credentials bound to the machine).

## 5. Time windows: who opens, who approves, what is logged

| Mechanism | Window mechanism | Who approves | Approval log | Effort |
|---|---|---|---|---|
| step-ca / Vault SSH certs | cert TTL (default 16 h, configurable; min 5 m — smallstep config docs) | provisioner decides (JWK password, OIDC SSO, or a script the *human* runs) | CA issuance log | medium (CA to run) |
| Teleport Access Requests | `--session-ttl` + `request.max_duration`; request itself expires in 1 h by default (docs) | configurable approvers; "users cannot approve their own requests"; Enterprise for full workflow | request + review with reason | high (service, payment) |
| Tailscale SSH check mode | `checkPeriod` 1 min – 168 h, default 12 h (docs) | the identity provider's login (SSO/MFA) on the initiating device | Tailscale auth logs | **low** |
| systemd timer removes key | literal: timer deletes the `authorized_keys` line / reverts to the closed state | whoever adds the key (human step) | a log line the script writes | trivial |

For this user: the orchestrator itself never needs a standing window. The pattern that fits C5/C6 is **no standing access at all for the agent, and a human-gated window for interactive debugging**. Tailscale SSH with `action: check` and a short `checkPeriod` is the cheapest honest version: the window opens only when the human re-authenticates, expires by itself, and the tailnet keeps the log — the agent inherits the window only while the human's session is fresh. If the agent (through the main thread) ever needs SSH directly, a cert with a short TTL signed by the human's one-off action (a small CA script or step-ca with a JWK provisioner) is the next step up; a timer that removes the key is the zero-dependency fallback.

## 6. Which operation needs which level

- **Observe (logs, status, metrics):** level 0 — *off the machine* if possible (2.7). An agent may always do this.
- **Deploy a reviewed commit:** level 1 — only through the pull pipeline (2.1/2.2). The agent commits to the deployment repo; the trusted side (human merge, or merge after review) crosses the boundary. No direct machine action. This is exactly the RUN_ISOLATION principle applied one hop further out.
- **Restart a service / health actions:** level 2 — allowed for the orchestrator through a narrow, audited verb interface (forced command or systemd-unit-scoped sudo, unprivileged user), or left to autoheal labels where possible. This is the highest level an agent should hold.
- **Change machine configuration:** level 3 — through the spec repo (commit + human review), never interactively. Interactively only within a time window opened by the human.
- **Read or rotate a secret (break glass):** level 4 — human-only, on the machine or via the secret tool, logged by the tool. No agent path exists, by design.

Human approval is required for: anything at level 3 and 4, the merge into the deployment branch for level 1 (same as the code boundary), and opening any interactive window for the agent.

## 7. Recommendation

**Combine pull-based deployment with zero standing SSH for the agent, and add a time-windowed human path for interactive debugging.** The deciding criteria are C5 (the pull is the same "agent proposes, trusted side pulls" boundary the project just chose for code) and C1/C2 (no agent-reachable inbound path, no agent-visible secrets).

1. **Service spec and deploy:** a deployment repo with the Compose files; on the host a systemd timer (docker-git-deploy, compose-sync, or oar) that pulls `main`, runs `docker compose up -d --wait`, and rolls back when unhealthy. Host needs read-only git and outbound HTTPS only. Secrets in `.env` on the host (human-managed), or as systemd encrypted credentials where a service needs them injected.
2. **Machine spec:** keep it small — a bootstrap script or minimal Ansible/Nix for users, firewall, Docker, the pull timer, and the sshd config; document it in the same repo. NixOS is the better long-term spec but is not required for a first version (deliver first).
3. **Observe:** ship logs/status off the machine (journald forwarding or an external healthcheck endpoint); agent diagnostics read from there.
4. **Interactive access:** Tailscale SSH with check mode (`checkPeriod` short, e.g. 1 h) for the human's window; if the orchestrator must ever SSH, a short-TTL SSH certificate signed on the human's explicit action. A key-removal timer is the fallback if Tailscale is unwanted.
5. **Restart verbs:** a forced-command dispatcher on an unprivileged user (`restrict,command=...`) exposing only `status`, `logs <unit>`, `restart <unit>` — with a sudo allowlist naming exactly those units. Give this only to the orchestrator, never to sandboxed subagents.
6. **Never:** agent-held deployment secrets, standing `authorized_keys` for any agent, interactive config changes outside a window.

## 8. Open questions

- Whether the user already runs (or wants) Tailscale on the servers — decides step 4 vs. a cert/timer approach.
- Whether any of the three small Compose GitOps tools (docker-git-deploy, compose-sync, oar) is mature enough to adopt vs. writing the 30-line timer script ourselves (docker-git-deploy is new and unstarred at research time; oar and compose-sync are single-maintainer). Usage will tell.
- Secret rotation story of the pull pipeline: today "human edits `.env` on the host" is the answer; sops-nix under NixOS would automate it but only after step 2 becomes Nix.
- Teleport/Boundary were judged but not benchmarked for a one-person setup; the effort table is from documentation, not a trial.
- Exact `checkPeriod` value and which operations (if any) the orchestrator may run inside the human's window need a decision from the user.

## 9. Searches run

- websearch "AI agents SSH access servers guardrails MCP server operations best practices 2026" — 5 relevant hits (AWS pattern guide, AgentBound, pySSHForAgents, CSA guide, gelse/ssh-mcp).
- websearch "GitHub Actions environments protected deployments approvals required reviewers" — 5 relevant hits (GitHub docs).
- websearch "Tailscale SSH check mode expiration approvers ephemeral access" — 1 failed (429); retry "tailscale SSH check mode require approval expiry documentation" — 5 relevant hits.
- websearch "NixOS vs Ansible vs Fedora CoreOS declarative server spec secrets sops-nix agenix rollback comparison 2025" — 4 relevant hits (NixOS wiki secrets comparison, discourse NixOS vs Ansible, secrets overview thread).
- websearch "step-ca smallstep SSH certificates host user certificate short validity documentation" — 5 relevant hits.
- websearch "systemd credentials LoadCredential encrypted secrets service documentation" — 5 relevant hits.
- websearch "Teleport access requests one-time SSH access approval expiry documentation" — 5 relevant hits.
- websearch "simple GitOps docker compose auto-update pull timer watchtower alternative self-hosted" — 5 relevant hits (docker-git-deploy, compose-sync, oar, watchdocker, shepherd).
- `gh search repos "ssh mcp server"` — 10 hits, 6 with substance; `gh search repos "kubernetes mcp server"` — 1 relevant (containers/kubernetes-mcp-server).
