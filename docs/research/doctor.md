# Research: a fast health check (`doctor`) for `oc-sub up` and `oc-sub run`

Date: 2026-09-30. Worktree `r-doctor`, commit `1f2d0de45a09b3c9f17acf041afb890850623d87`.
Cost of this research: 0.00 USD (no paid API calls).

Question: how should `oc-sub` check the agent setup of a project and of the
host, so that `up` and `run` can run the check on every invocation without a
noticeable delay (target: well under 100 ms), with a fallback of "re-run after
idle time and on watched-file change" when speed cannot be guaranteed.

## Criteria

From the Values of the global rules and the brief:

1. **Speed** — the per-invocation cost of `up`/`run` with the check stays well
   under 100 ms on Linux and on WSL2.
2. **Correctness without content reads** — the check never reads `.env`
   content or key files; it only tests existence and metadata.
3. **Actionable failure output** — every failure names its fix, like the
   doctors of other tools; machine-readable mode exists for agents.
4. **Established patterns** — the design follows proven prior art instead of
   inventing one; a library is used where an established one fits, otherwise
   the code stays small.
5. **Right place for each check** — fast checks run in `up` and `run`, slow
   checks run where their cost is already paid or where the user asked
   (`doctor`); a check stops or warns depending on its place.
6. **Small steps and testability** — every check is a pure-ish function with
   injected dependencies, like the existing `SandboxDeps` pattern
   (`src/sandbox.ts`, lines 336–357).

## 1. Prior art: how other tools structure a doctor

Facts, each with a source:

| Tool | Structure | Levels | Exit code | Machine-readable | Fix naming |
|---|---|---|---|---|---|
| `brew doctor` | Named check methods (`check_*`) in a `Diagnostic::Checks` class; each returns `Finding` objects. `brew doctor <check>` runs single checks, `--list-checks` lists them. | One level per finding, plus a support `tier`; warnings print with `opoo`. | Fails (`Homebrew.failed`) when any check reports a finding. | `--json` prints `{tier, findings[]}`. | Finding text carries the remedy; docs tell users to run `brew doctor` before filing issues (https://docs.brew.sh/Troubleshooting). Source: https://docs.brew.sh/rubydoc/Homebrew/Cmd/Doctor.html |
| `flutter doctor` | `DoctorValidator` objects run concurrently through `ValidatorTask`, each with a per-validator timeout; a crash becomes a `ValidationResult.crash`, not a failed run. | `ValidationType`: `success`, `partial`, `notAvailable`, `missing`, `crash`. `partial` = installed with issues. | `doctorResult` false when any validator is `missing` or `crash`; prints "Doctor found issues in N categories" vs "No issues found!". | `--machine` / daemon mode: "Outputs in a machine readable structured JSON format" (https://github.com/flutter/flutter/blob/f916dd68/packages/flutter_tools/lib/src/runner/flutter_command.dart, `addMachineOutputFlag`). | Message objects carry a `contextUrl` printed as a fix hint. Source: https://github.com/flutter/flutter/blob/5c6367c2/packages/flutter_tools/lib/src/doctor.dart |
| `mise doctor` | One Rust function that pushes strings into `errors` and `warnings` arrays; sections (`dirs`, `env_vars`, `toolset`, `shims`). Named sub-checks runnable via `mise doctor <check>`. `mise doctor project` runs project-declared checks with `run`, `description`, `hint`, `timeout`, `os` fields; checks run concurrently, a failed check does not stop others. | Two levels: error vs warning. Project checks: `pass`, `fail`, `error` (could not execute/timeout), `skipped` (platform). | Exit status 1 if any error (or `fail`/`error` in project mode). | `--json` / `-J`; project checks also emit JSON with `name`, `status`, `message`, `hint`. | `hint` field shown after a failure, "Never executed" — pure remediation text. Sources: https://mise.jdx.dev/configuration/project-diagnostics.html , https://github.com/jdx/mise/blob/main/src/cli/doctor/mod.rs |
| `npm doctor` | Fixed named groups (`connection`, `registry`, `versions`, `environment`, `permissions`, `cache`), runnable individually as arguments. | One level; "recommended changes". | Fails when checks fail. | No machine mode. | Prose remedy per section. Source: https://docs.npmjs.com/cli/v12/commands/npm-doctor/ |
| Laravel `doctor` (2026, the most modern design) | Each diagnostic is one class returning a `DiagnosticResult`; a stable machine code is derived from names (`application-key-is-set.missing`). | `pass`, `notice`, `warn`, `fail`, `skip`, `error`; exit code controlled by `--fail-on=warn/never`. | `fail`/`error` fail the run; `warn` only with `--fail-on=warn`. | `--format=json`, `--format=github`, and an agent-optimized one-line JSON format with aggregate counts and only actionable outcomes. | `fix` remediation string per issue; deterministic fixes get `--fix`. Source: https://github.com/laravel/doctor/blob/main/README.md |

Converging design across all of them:

- A **registry of named checks**, each returning a status, a message, and a
  remediation ("hint"/"fix"/`contextUrl`). Checks are individually runnable
  (`brew doctor <check>`, `npm doctor <group>`, `mise doctor project`).
- **Two levels, sometimes three**: error (blocks) vs warning (informational);
  `flutter` adds `partial` and `skip`, Laravel adds `notice`. All agree that a
  check that could not execute is its own status (`error`), not a pass.
- **Exit code 1 on error, 0 with only warnings** (Laravel makes the warning
  threshold explicit with `--fail-on`).
- **A `--json` mode** with per-check status, message, and hint fields.
- **Per-check timeout** so one hung probe cannot hang the doctor (`flutter`
  caps a validator at 4.5 min; `mise` project checks default to 10 s).
- Output ends with a one-line summary ("No problems found" / "Your system is
  ready to brew.").

## 2. Speed: measurements in this worktree

Machine: native Linux (not WSL2), ext4, kernel 7.0.12, bun 1.4.x. Script:
`.opencode/context/stat-bench/bench.ts` (git-ignored scratch folder). It
creates 200 files plus 50 symlinks, then does 20 rounds of: `lstat` on all 250
paths plus a follow-`stat` on each symlink (the pattern a doctor needs:
existence, type, size, and symlink target).

| Measurement | Result |
|---|---|
| 250 lstat + 50 follow-stats, median of 20 rounds | **1.50 ms** (min 1.24 ms, p90 1.85 ms, max 2.47 ms) |
| Per call | ~6 µs |
| One `git rev-parse HEAD` subprocess (`Bun.spawnSync`) | ~7.9 ms |
| One `sbx ls` subprocess | ~0.29 s (292 ms wall) |

Conclusions:

- **The stat checks are effectively free.** Even 500 stat calls cost about
  3 ms — three orders of magnitude below the 100 ms budget. No caching is
  needed to hit the target on native Linux; a fingerprint cache is still worth
  having for WSL2 and for skipping re-computation, but it is an optimization,
  not a necessity (see Section 3).
- **Subprocesses dominate.** One git call (~8 ms) is fine per invocation. One
  `sbx` call (~300 ms) alone breaks the budget — sandbox checks cannot run on
  every `up`/`run` if the target is "well under 100 ms".
- **WSL2 is the real risk, and only on NTFS.** Measured by Microsoft engineers
  responding to a bug report: `stat()` costs ~1.1 µs on native Linux ext4,
  ~47 µs on WSL2's own ext4, and **~900–1700 µs per stat on WSL2 accessing
  NTFS via the 9P server** (https://github.com/microsoft/wslg/issues/264,
  reply from the WSL team: "The NTFS drives are mounted as remote file
  system. You should not expect close to native performance"). Independent
  measurement: WSL2 on its ext4 is "very close to native Linux performance",
  WSL2 on NTFS via 9P is "unusably slow"
  (https://vxlabs.com/2019/12/06/wsl2-io-measurements/). So: 200 stats on WSL2
  ext4 ≈ 0.2–10 ms (fine); the same 200 stats on a project living on
  `/mnt/c/...` ≈ 0.2–0.35 s (fails the target). **The fingerprint cache is
  therefore required, not optional**: it makes the WSL2-on-NTFS case fast
  after the first run, because a changed fingerprint costs one stat per
  watched path only when something actually changed — but note that on NTFS
  even the *verification* stats cost the full 1 ms each. Mitigation for that
  worst case: an idle-time TTL (Section 3), so a stale-but-recent fingerprint
  short-circuits the stats entirely for a bounded time.

## 3. Invalidation: fingerprint vs TTL vs idle time

- **direnv** is the established precedent for stat-only fingerprints: it keeps
  `DIRENV_WATCHES`, which records "name, mtime, existence of all watched
  files", and re-runs the `.envrc` on the next prompt when the watch list is
  stale (https://github.com/indigoviolet/direnv-cache, section on
  `DIRENV_WATCHES`; stdlib `watch_file`:
  https://direnv.net/man/direnv-stdlib.1.html). direnv accepts that the check
  runs on every prompt and stays linear in the number of watched files
  (https://github.com/direnv/direnv/issues/173, "direnv's execution time on
  every prompt is linear to the number of files. It's probably fine on SSDs").
- **TTL / time-based re-run**: `mise doctor` refreshes its new-version notice
  at most hourly (`version::check_for_new_version(duration::HOURLY)`,
  src/cli/doctor/mod.rs). Nothing in the surveyed tools uses a pure TTL for
  correctness checks; TTLs appear only for *external* lookups (new versions,
  registry pings).
- **File watching (inotify)**: none of the CLI doctors uses it; it needs a
  long-lived process, which `oc-sub up`/`run` (short-lived CLIs) do not have.

Recommended hybrid for `oc-sub`:

1. **Stat checks (checks 1–6 of the brief)**: recompute the fingerprint on
   every invocation when cheap (native Linux: ~1–3 ms — just always run), and
   keep the direnv-style fingerprint (`path → {mtime, size, inode, mode,
   symlinkTarget}`) persisted in the oc-sub state file so the *result* of the
   last run can be trusted when the fingerprint is unchanged and the last run
   is younger than an idle TTL (for example 24 h). The fingerprint must cover
   the directory listings it depends on: the project root, each worktree
   directory under `.worktrees/` (readdir of `.worktrees/` must itself be in
   the fingerprint, so a new worktree invalidates), `~/.claude/skills/`,
   `~/.agents/skills/`, and the global rule files.
2. **Slow checks**: never on the hot path.
   - *Sandbox mounts* (`sbx ls`, ~300 ms): run in `up` only — `upSandbox`
     already calls `sbx ls` anyway (`src/sandbox.ts` line 516), so the doctor
     there costs nothing extra — and in `oc-sub doctor`. In `run`, never call
     `sbx`; if a sandbox state file exists, trust it, because `run` talks to
     the server URL and a broken mount shows up as a failed request anyway.
   - *Plugin freshness*: the cheap form is enough. Read the installed
     plugin's recorded commit SHA and compare it to the repository HEAD
     (`git rev-parse`, ~8 ms). Per `docs/research/plugin-updates.md`, the
     installed copy lives at
     `~/.claude/plugins/cache/opencode-subagents/opencode-subagents/<version>/`
     and `installed_plugins.json` records `gitCommitSha`; when the plugin is
     loaded live (`--plugin-dir` or a local-path marketplace) there is no
     cache copy and the check is skipped (on the machine of this worktree no
     `~/.claude/plugins/` exists, which is the live-loading case). This
     comparison is a fingerprintable input: the repository HEAD and the cache
     directory mtime both go into the fingerprint.

## 4. Library or hand-written?

- **npm**: `npm search doctor healthcheck cli` (12 hits) returns only
  domain-specific tools (`@react-native-community/cli-doctor`, `expo-doctor`,
  `@percy/cli-doctor`, express healthcheck middleware) — no generic check
  registry. The closest is **`yeoman-doctor` 6.0.0** (64 GitHub stars,
  repo `yeoman/doctor` not archived, last push 2025-09-25): a list of check
  tasks with title/solution and failure collection. It is yeoman-environment
  flavoured, has a small community, and would pull yeoman dependencies into a
  Bun project for what is roughly 150 lines of code. **Not adopted** —
  fails criterion 4 (established for *this* use case) and criterion 6 (small
  dependency-free steps).
- **File fingerprinting**: direnv's model is a flat map, not a library; no
  established npm library is needed — `lstatSync` + `readlinkSync` cover it,
  both already exercised in this repo's style of sync helpers
  (`src/sandbox.ts` uses `existsSync`, `readFileSync`, `readdirSync`).
- **Decision**: write the check registry (~a `Check` type: `name`, `level`,
  `run() → {status, message, fix}`), the fingerprint helpers, and the JSON
  printer by hand, in `src/doctor.ts`, with a `DoctorDeps` injection object
  mirroring `SandboxDeps` so tests use fakes, exactly like the existing tests
  in `test/sandbox.test.ts`.

## 5. Where do the checks run, and what happens on failure?

Judging against the criteria (speed, right place, actionable output):

| Place | What runs | On error | On warning |
|---|---|---|---|
| `oc-sub doctor` | All checks, including slow ones (`sbx ls`, plugin compare). `--json` mode for agents; single checks selectable by name (brew/npm/mise pattern). | Exit 1, print all findings with their fix, end with a summary line. | Printed, exit 0. |
| `oc-sub up` | Full fast set (stat checks, ~1–3 ms). Sandbox checks run anyway inside `upSandbox` — the doctor only deduplicates them. | **Stop** (matches the current hard-error behaviour of `upSandbox`, e.g. missing shared AGENTS.md, `src/sandbox.ts` lines 464–473). | Warn, continue. |
| `oc-sub run` | Fast set only, gated by the fingerprint cache: unchanged fingerprint + result younger than the idle TTL → skip entirely (zero cost); otherwise re-run the fast checks. Never a subprocess except the fingerprint verification itself. | **Stop**: a run without a key file or with a broken global-rule link wastes a paid API call, which the global rules forbid ("money is not spent on pointless trials"). | Warn, continue. |

Checks that cannot use the fingerprint (per the brief): the sandbox-mount
check (needs `sbx ls`) runs only in `up`/`doctor`; the plugin-freshness check
needs one git call but is itself cheap (~8 ms) and can be fingerprinted on
the repository HEAD.

## The checks of the brief, reviewed one by one

1. **No real `.env` in the project or worktrees** — kept. Implementation note:
   readdir the project root and each `.worktrees/*` directory, flag any
   filename matching `.env` / `.env.*` that is not `.env.example` /
   `.env.sample` (or `*.example` / `*.sample`). Existence check only; never
   open the file. Question raised: worktrees created by this project live in
   `.worktrees/`, but Claude Code's own worktrees may live elsewhere; the
   check should also accept a configurable extra directory list.
2. **No `CLAUDE.md` / `CLAUDE.local.md` in the project** — kept; pure
   existence check in the project root (and, worth deciding during
   implementation: in worktrees too, since a generated worktree can inherit
   one from a bad source).
3. **Project has `AGENTS.md`** — kept; existence check.
4. **Global rules are links to one source** — kept. Implementation: `lstat`
   the three paths; require them to be symlinks (`isSymbolicLink`), resolve
   with `readlinkSync`, and require the resolved target to exist and to equal
   the canonical `~/dv/meta/agents/AGENTS.md`. Covers copy-instead-of-link and
   broken link in one check.
5. **Every skill link in `~/.claude/skills/` and `~/.agents/skills/`
   resolves** — kept. readdir + `lstat` each entry; a symlink whose target
   does not exist fails. On native ext4 this is sub-millisecond for dozens of
   skills; on WSL2/NTFS the home directory is normally inside ext4, so no
   9P penalty.
6. **No project copy of the plugin agents beyond a permission-only file** —
   kept, with the rule defined by `docs/research/agent-merge.md` (lines 76–88):
   a project `.opencode/agents/coder.md` / `researcher.md` is allowed only if
   its content is a permission-only block (frontmatter with `permission`,
   no `prompt`, `description`, or `model` field). Unlike checks 1–5 this one
   must *read a file's frontmatter* — it is the one content-reading check, but
   it reads only the agent file, never `.env`-like files. Fingerprint it like
   the rest.
7. **Sandbox has the shared mount; plugin is not older than the repository** —
   kept, but **moved out of the hot path**: the mount check duplicates what
   `upSandbox` already does with `listsMounts` (`src/sandbox.ts` lines
   399–404, 547–553), so `up` gets it for free and `run` must not pay 300 ms
   for it. The plugin check compares the recorded installed SHA against the
   repository HEAD per `docs/research/plugin-updates.md` (the version-pinned
   cache is the documented no-update failure mode, §1 and §4 of that report).

## Options judged by criteria

The real design choice is the *invalidation strategy* for the fast checks.
All options keep the same check set and output format.

| Option | Speed (Linux) | Speed (WSL2/NTFS) | Freshness | Complexity | Fits existing structure |
|---|---|---|---|---|---|
| A. Always run all fast checks, no cache | ~1–3 ms, passes | 0.2–0.35 s for 200 stats, fails target | Always fresh | Smallest | Yes |
| B. Fingerprint cache only (direnv-style), no TTL | ~1–3 ms to verify, ~0 on hit* | Still ~1 ms/stat to verify — 0.2 s+, fails worst case | Fresh on any watched change | Small | Yes |
| C. TTL only, no fingerprint | ~0 on hit, full re-run each TTL | ~0 on hit | Stale up to the TTL after a change | Small | Yes |
| D. Fingerprint + idle TTL (recommended) | ~0 on hit, ~1–3 ms on change | ~0 on hit | Fresh on change *and* at least once per TTL | Moderate (state file already exists: `src/state.ts`) | Yes, mirrors direnv + mise's hourly pattern |

\* Option B's per-call cost on NTFS is the verification stats themselves, so
B alone does not save the WSL2 worst case; only the TTL does. That is why D
combines both, and why direnv itself (which has no TTL) is fine on Linux but
would be too slow per prompt on NTFS.

Other decisions, each against the criteria:

- **Write the registry by hand vs `yeoman-doctor`**: hand-written wins on
  criteria 4 and 6 (no yeoman dependency, ~150 lines, fully testable with the
  existing fakes pattern).
- **`run` stops vs warns on error**: stop wins on criterion 5 — a run against
  a broken setup spends a paid API call and produces a worse failure later
  inside the agent.
- **Sandbox checks in `run`**: excluded — fails criterion 1 (~300 ms for one
  `sbx ls` call, measured) and is redundant, because a broken sandbox surfaces
  as a failed HTTP request in `run` anyway.

## Recommendation

1. Add `src/doctor.ts` with a named check registry: every check returns
   `{status: "pass" | "warn" | "fail" | "error" | "skip", message, fix}`,
   with a `DoctorDeps` injection object, `--json` output, exit 1 on
   `fail`/`error`, and a one-line summary — the converging pattern of brew,
   mise, flutter, and Laravel doctor.
2. Checks 1–6 run in `up` (stop on `fail`) and in `run` (stop on `fail`), with
   option D: recompute the stat fingerprint whenever it is cheap and cache the
   result under the oc-sub state folder, keyed by a fingerprint of
   `{path → mtime, size, inode, mode, linkTarget}` for the project root, the
   `.worktrees/` listing, the skills directories, and the global rule files;
   skip when the fingerprint is unchanged and the cached result is younger
   than an idle TTL (24 h default).
3. `oc-sub doctor` runs everything, including the sandbox-mount check (via the
   existing `listsMounts`) and the plugin-freshness check (installed SHA vs
   repository HEAD), and prints the fix for every finding.
4. No external library; tests mirror `test/sandbox.test.ts` with fake deps.

## Open questions

- Whether the `.env` check should also scan a user-configurable list of extra
  directories (for worktrees created outside `.worktrees/`).
- Whether the plugin-freshness check can read `installed_plugins.json`
  reliably across Claude Code versions — on this machine no plugin cache
  exists (the plugin loads live), so the exact JSON shape of
  `installed_plugins.json` and its `gitCommitSha` field is documented only by
  `docs/research/plugin-updates.md` and must be verified against a
  cache-installed machine.
- The idle TTL value (24 h proposed) — a guess; tune after real use.
- WSL2 numbers come from public bug reports (wslg#264, vxlabs), not from a
  measurement on the user's own WSL2 machine; the design assumes ~1 ms per
  stat there, which should be confirmed once.
- Whether `oc-sub run` should print a one-line "setup ok (cached)" on a
  fingerprint hit or stay silent; silent is proposed, verbosity is a taste
  question for the user.

## Search log

- `websearch`: "brew doctor flutter doctor mise doctor npm doctor design exit
  codes warning levels machine readable output" — 5 highly relevant hits
  (mise project-diagnostics, brew Doctor rubydoc, brew Troubleshooting,
  npm-doctor docs, mise doctor source, plus laravel/doctor README).
- `websearch`: "direnv stdlib watch_file implementation mtime cache
  invalidation" — 3 relevant hits (direnv-cache internals, direnv issue #173,
  direnv-stdlib man page, stdlib.sh source).
- `websearch`: "flutter doctor --machine JSON exit code documentation" — 3
  relevant hits (flutter issue #10621, daemon.md, flutter_command.dart /
  doctor.dart sources).
- `websearch`: "WSL2 filesystem stat performance ext4 9P drvfs slow metadata"
  — 4 relevant hits (WSL#9430 with strace table, wslg#264 with per-stat
  timings, vxlabs WSL2 IO measurements, WSL#4515).
- `npm search --json doctor healthcheck cli` — 12 hits, none a generic check
  registry; closest `yeoman-doctor` 6.0.0 (64 stars, last push 2025-09-25,
  not archived) — judged not worth the dependency.
- Measured locally: Bun stat benchmark (`.opencode/context/stat-bench/
  bench.ts`), `git rev-parse` subprocess timing, `sbx ls` subprocess timing.

## Review of the main thread (2026-09-30)

The benchmark above ran inside the sandbox VM. The main thread ran the same script on the WSL2 host, where `oc-sub up` and `oc-sub run` run. The projects in `~/dv` live on the ext4 disk of WSL2, not on `/mnt/c`.

| Measurement on the WSL2 host | Result |
|---|---|
| 250 stat and readlink calls, median | 0.66 ms (p90 0.93 ms) |
| One git subprocess | 2.1 ms |

Decision: option A. The fast checks run on every `up` and `run` without a cache, because they cost about 1 ms. A fingerprint cache would add state and code for no measured gain. The check for the sandbox mounts runs only in `up` and `oc-sub doctor`, because `up` calls `sbx ls` anyway. If a project ever lives on `/mnt/c`, the doctor measures its own time and warns when it takes more than 50 ms. The cache of option D is the next step only then.

The claim that no plugin cache exists is true only inside the sandbox. The host has `~/.claude/plugins/installed_plugins.json` with `gitCommitSha`, so the plugin check can use it.
