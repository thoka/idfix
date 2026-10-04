# Design: a sandbox for each runner job (step 32b)

Status: draft of 2026-10-04. The spike of step 32c can change it.

Inputs: [runner-job-sandbox.md](../research/runner-job-sandbox.md) (step 32a), the decisions 16 and 17 of meta plan step 12, and arch-helper fix 50 (`alpha` 0856b95). arch-helper belongs to the supervisor. idfix sends it a change list and does not edit it.

## 1. Goal and limits

Each GitHub Actions job of the self-hosted runner operates in its own sbx microVM. The VM exists for one job only. The host only starts and removes VMs. This closes two gaps of option (a): Docker images that stay between jobs, and full network access.

Out of scope for the first version: parallel jobs, a template image, and the secret proxy for the Claude token.

## 2. Split of the work

| Part | Owner | What it does |
|---|---|---|
| `prepare` and `cleanup` of fix 50 | arch-helper (root) | Gets the JIT configuration with the root-only PAT. Removes old state. |
| `gh-runner@.service` | arch-helper | Gives the job the JIT configuration and `CLAUDE_CODE_OAUTH_TOKEN` (from `LoadCredential=claude-oauth.token`). Calls `idfx job run`. |
| `gh-runner-sbx.service`, `gh-runner-sbx-login.service` | arch-helper | The sbx daemon of `gh-runner` with `--policy deny-all`, and the PAT login from a root-only credential. |
| `idfx job run` | idfix | Creates the job sandbox, sets its network rules, runs the runner inside, and removes the sandbox. |
| `idfx job prune` | idfix | Removes job sandboxes that a crash left. `ExecStartPre=` and `ExecStopPost=` call it. |

idfix owns the sbx part, because idfix already drives sbx and has tests for it. arch-helper owns the system part: users, units, and credentials.

## 3. The command `idfx job run`

```
idfx job run --instance INST --runner-dir DIR [--shared-dir DIR] [--allow-file FILE]
             [--cpus N] [--memory SIZE]
```

The environment of the call holds `ACTIONS_RUNNER_INPUT_JITCONFIG` and `CLAUDE_CODE_OAUTH_TOKEN`. The command never takes a secret as an argument.

Steps:

1. Prune: `sbx rm --force` for each sandbox `job-<INST>-*`.
2. Create: `sbx create --name job-<INST>-<unix time> --cpus N --memory SIZE shell <runner-dir>:ro [<shared-dir>:ro]`. The paths are relative and the working folder is `/`, because sbx 0.45.1 accepts a read-only mount only with a relative path.
3. Network: add the deny rules of `NETWORK_DENY_HOSTS`, then the base allow list, then the hosts of `--allow-file`. All rules are scoped to the sandbox.
4. Run: `sbx exec -e ACTIONS_RUNNER_INPUT_JITCONFIG -e CLAUDE_CODE_OAUTH_TOKEN -e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 <name> bash -c 'cp -a <runner mount> ~/runner && cd ~/runner && exec ./run.sh'`. The secret variables go by name only, so their values never show in `/proc/*/cmdline`.
5. Remove: `sbx rm --force <name>`. This also runs after a failure or a signal (`try`/`finally` and a `SIGTERM` handler).
6. The exit code is the exit code of `run.sh`.

Defaults: `--cpus 4`, `--memory 8g`, one job at a time.

### 3.1 The base allow list

The allow list is a data file in the repository, `src/job/allow-hosts.txt`, one host per line, with a comment per group. It holds the GitHub runner hosts, the GitHub package hosts, and the Claude Code hosts of section 3.2 of the report. The registries of the projects come from the `sbx policy log` of the spike, not from a guess. A project adds its own hosts with `--allow-file`.

### 3.2 Rules that follow from the goal

1. No global Anthropic secret and no `/login` in the store of `gh-runner`. Otherwise the proxy writes over the token (sbx issue #144). `idfx doctor` gets a check for this.
2. The agent kit is `shell`, not `claude`, because the `claude` kit can set an `apiKeyHelper` that ranks above the token.
3. Stdin of each sbx call is closed, so that a missing login fails and does not wait for a device code.

## 4. Known gaps

1. A prompt injection in the job can copy the Claude token and use it until the user revokes it. If sbx supports it later, way B of the report (the secret proxy) closes this gap. Watch sbx issues #11 and #601.
2. `github.com` and `*.blob.core.windows.net` stay open, so data can still leave through them. An HTTP path rule for `github.com` is a test of the spike.
3. The runner copy and its libraries make each start slower. A template image comes later.

## 5. Sub-steps after the spike

1. 32c: the spike by hand as `gh-runner` (items of section 10 of the report, and the narrowest PAT scope that `sbx login` accepts). Then the final change list for fix 50 to the supervisor.
2. 32d: `idfx job run` and `idfx job prune` with unit tests on a fake runner, and one real run against a test repository. The lesson `fake-runner-hides-wrong-command` applies: each new sbx command runs once for real.
3. 32e: the `doctor` checks for the store of `gh-runner` (no global Anthropic secret, policy deny-all, daemon answers).
4. 32f: README and GUIDE sections for the runner mode.
