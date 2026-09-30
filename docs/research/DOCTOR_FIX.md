# Research: how should `oc-sub doctor --fix` repair problems?

Date: 2026-09-30. Worktree `r-doctor-fix`, branch `feature/r-doctor-fix`.
Extends [DOCTOR.md](DOCTOR.md). Cost of this research: 0.0112 USD at OpenRouter (opencode estimate
0.0193 USD), GLM 5.3 Flash, 8m49s.

Question: how should the planned `--fix` flag of `oc-sub doctor` run repair
actions, guard destructive ones, order dependent fixes, and report failures?

## Criteria

From the Values of the global rules and the brief:

1. **No prompt, agent-safe** — agents run this command without a terminal, so
   the command must never block on stdin.
2. **Blast radius small by default** — a fix that can end a session or lose
   work needs an extra explicit flag (`--force`), like every setting that
   shrinks the blast radius is the default.
3. **Established patterns** — the flag names, guards, and exit codes follow
   the prior art below, not an invention.
4. **Transparent** — the command prints what it will do and what it did;
   a dry-run mode exists or is cheap to add.
5. **Small steps and testability** — each fix action is a small injected
   function next to the existing check registry in `src/doctor.ts`, testable
   with fakes like `test/sandbox.test.ts`.
6. **Correct ordering** — dependent fixes run in dependency order, and the
   checks verify the result afterwards.

## 1. Prior art: how tools split diagnose from repair

Facts, each with a source:

| Tool | Diagnose vs repair | Runs without a question? | Guard for destructive fixes |
|---|---|---|---|
| `brew doctor` vs `brew cleanup` | `brew doctor` never repairs: it only prints warnings, and the troubleshooting docs tell the user to read and correct each one by hand (https://docs.brew.sh/Troubleshooting, https://docs.brew.sh/Common-Issues). The repair lives in a *separate* command, `brew cleanup`. | `brew cleanup` runs without a prompt, but Homebrew already runs it automatically every 30 days by default (https://docs.brew.sh/FAQ). | `brew cleanup --dry-run` prints "Would remove: ..." lines; without `--dry-run` it removes. `brew bundle cleanup` goes further: dry-run output is the *default*, it exits 1 when it would change anything, and prints "Run `brew bundle cleanup --force` to make these changes." — the guard is a dry-run default plus an explicit `--force` (https://docs.brew.sh/rubydoc/Homebrew/Cmd/Bundle/CleanupSubcommand.html). |
| `flutter doctor` | No fix mode at all; every validator only prints status and a fix hint (see DOCTOR.md §1, flutter `doctor.dart`). | — | — |
| `eslint --fix` | One command does both: `--fix` applies all safe fixes and then reports *only the remaining unfixed issues* (https://eslint.org/docs/latest/use/command-line-interface, `--fix` section). | Yes, no prompt. | Two guards: not every rule is fixable, and `--fix-dry-run` runs the same fixes "without saving the changes to the file system" (same page). There is no `--force`; unsafe fixes are simply not auto-applied. |
| `npm audit fix` | One command: `fix` "applies remediations to the package tree"; the exit code is 0 when the remediation fixed everything (https://docs.npmjs.com/cli/v10/commands/npm-audit/). | Yes, safe remediations run without a prompt. | A remediation that would change dependency ranges "will require the `--force` option to apply". The docs warn: "If you don't have a clear idea of what you want to do, it is strongly recommended that you do not use this option!" A `--dry-run` flag exists. |
| `rustup update` vs `rustup self update` | Both are repair/update commands; the split is by *scope* (toolchains vs the installer), not by safety (https://rust-lang.github.io/rustup/basics.html). | Yes, no prompt. | No destructive case; instead rustup disables automatic self-update when the `CI` environment variable is set (https://github.com/rust-lang/rustup/blob/master/src/cli/self_update.rs, `SelfUpdateMode::from_cfg`) — a guard by *environment*, relevant for agents. |
| `cargo fix` | Applies compiler suggestions to source files (https://doc.rust-lang.org/cargo/commands/cargo-fix.html). | Yes, but only under preconditions. | Refuses to run without a VCS (`--allow-no-vcs` overrides) and refuses on a dirty working tree (`--allow-dirty` overrides) — the guard is a *precondition check*, not a prompt. |
| `mise doctor` | Diagnose only; the `hint` field is remediation text that is never executed (see DOCTOR.md §1). Project checks have no fix mode. | — | — |
| `yarn dedupe --check` | `-c,--check` "will only report the found duplicates, without persisting the modified dependency tree. If changes are found, the command will exit with a non-zero exit code" (https://yarnpkg.com/cli/dedupe) — an inverted dry-run: check is opt-in, repair is the bare command. | Yes, bare `yarn dedupe` repairs without a prompt. | The dry run is the CI guard. |
| `git fsck` vs `git gc` | `fsck` diagnoses and never changes anything; `gc` repairs and is safe by design: it "tries very hard not to delete objects that are referenced anywhere" and keeps any object newer than the prune grace period (default 2 weeks) (https://git-scm.com/docs/git-gc). | `git gc` without flags runs unattended and is safe. | The destructive case (`--prune=now`) "prunes loose objects regardless of their age and increases the risk of corruption if another process is writing to the repository concurrently" — so the default keeps a grace period, and the unsafe shortcut is opt-in. |

Converging pattern:

- **Doctors never fix; fixers are separate flags or commands.** brew, flutter,
  and mise have no fix mode at all; the ones that do (`eslint --fix`,
  `npm audit fix`, `cargo fix`, `yarn dedupe`) are lint/update tools where the
  fix is the main purpose. `oc-sub doctor --fix` is therefore a reasonable
  shape, but it must keep the diagnose-only default.
- **Safe fixes run without a question.** Every tool above that fixes at all
  applies the safe subset silently and unattended (agents run npm and eslint
  in CI daily).
- **Destructive fixes get three kinds of guards, never a prompt:**
  1. an explicit flag (`npm audit fix --force`, `brew bundle cleanup --force`),
  2. a dry-run mode (`--dry-run`, `--fix-dry-run`, `brew cleanup --dry-run`,
     `yarn dedupe --check`),
  3. preconditions that refuse to run (`cargo fix` refuses on a dirty tree or
     no VCS; `git gc` keeps a grace period; rustup disables auto-update in CI).
- **Output reports what was fixed and what remains**; exit 0 means "fixed or
  already clean", non-zero means "problems remain" (npm, eslint, yarn
  `--check`, brew bundle dry-run).

## 2. Should `--fix` prompt? No.

- No surveyed tool prompts by default; the guard is a flag, a dry run, or a
  precondition (Section 1). Homebrew's `Ask.confirm?` in `brew bundle cleanup`
  only prompts *on a TTY* and otherwise tells the user to rerun with
  `--force` (https://docs.brew.sh/rubydoc/Homebrew/Cmd/Bundle/CleanupSubcommand.html)
  — the non-TTY behaviour is exactly what agents need: refuse, print the flag.
- rustup turns automatic self-update off when `CI` is set
  (https://github.com/rust-lang/rustup/blob/master/src/cli/self_update.rs).
- Decision for `oc-sub`: **never prompt**. If stdin is not a TTY and a fix
  needs `--force` without the flag, print an error and exit non-zero. Same
  behaviour with or without a TTY is simpler and matches the agent-first use.

## 3. Plan and dry run

- `brew cleanup --dry-run` prints "Would remove" lines; `brew bundle cleanup`
  makes that the default and exits 1 (Section 1). eslint's `--fix-dry-run`
  exists mainly for integrations that want the fix result without writing it
  (https://eslint.org/docs/latest/use/command-line-interface).
- Decision: print a one-line plan before each fix
  (`fix plugin-fresh: claude plugin marketplace update ...`), which costs
  nothing and doubles as an audit trail. A separate `--dry-run` flag is
  **deferred**: the four candidate fixes are few and their effect is visible,
  and the diagnose-only default (`doctor` without `--fix`) already acts as the
  dry run for which fixes *would* run — the fix text of every finding already
  says what `--fix` would do. If a later fix action grows dangerous side
  effects beyond `--force`, add `--dry-run` then.

## 4. Order and dependencies

- Prior art orders fixes by dependency inside one pass: `npm audit fix` runs a
  full `npm install` under the hood and then re-audits
  (https://docs.npmjs.com/cli/v10/commands/npm-audit/); `cargo fix` loops
  `cargo-check` and fixes in rustc's diagnostic order
  (https://doc.rust-lang.org/cargo/commands/cargo-fix.html); eslint applies
  fixes in up to 10 iterations and then reports what remains
  (https://github.com/eslint/eslint/discussions/15668). The common shape:
  **fix in dependency order, then re-run the checks, and report what still
  fails.**
- Decision for `oc-sub`: a fixed order — plugin update first, then the server
  restart that loads the new plugin folder, then file-level fixes (global
  rules), then the sandbox recreate last (it needs a working `up` and is the
  most destructive). After the fix pass, run the checks again and print their
  results; the re-run result decides the exit code. One re-run is enough; the
  fix actions are idempotent, so a user can run `doctor --fix` again if
  something still fails.

## 5. Reporting a failed fix, and the exit code

- `npm audit fix` exits 0 when the remediation fixed everything, non-zero
  otherwise (https://docs.npmjs.com/cli/v10/commands/npm-audit/). eslint exits
  0 only when no errors remain after fixing
  (https://eslint.org/docs/latest/use/command-line-interface, `--max-warnings`
  section). `yarn dedupe --check` exits non-zero when work remains
  (https://yarnpkg.com/cli/dedupe).
- Decision: the exit code comes from the **re-run**, not the fix pass, so the
  same rule as `doctor` holds — exit 1 when any check is `fail` after fixing,
  0 otherwise. A `warn` does not fail (`plugin-fresh` is a warn, so a failed
  plugin update alone exits 0; that is too soft — see the design below: when a
  fix action itself errors, that check's re-run result is forced to `fail`).
  A fix action that throws is caught, printed as
  `fix failed (<check>): <error>`, and the re-run shows the check as still
  broken.

## 6. Guarding the sandbox recreate

The recreate (`sbx rm --force NAME`, then `oc-sub up`) ends all sessions in
the sandbox and destroys unfetched work in the clone (PLAN.md step 14). The
prior art guards this with preconditions, not prompts (`cargo fix`, `git gc`;
Section 1). Preconditions that make it safe with `--force`:

1. **No busy session**: reuse the busy check of `down`
   (`busySessions` in `src/down.ts`, lines 47–57): list the directories of the
   sandbox's run folders and query the server; any busy session aborts the
   fix, unless `--force` is given twice (`--fix --force` skips it, matching
   `down --force` at `src/down.ts` line 89).
2. **No unfetched work**: before `sbx rm`, run
   `git -C <root> fetch sandbox-<name>` and check every `feature/*` branch of
   the remote against `alpha`; if a branch has commits not on `alpha`, the
   recreate aborts and prints `oc-sub fetch` and the review command. This is
   the same grace-period idea as `git gc`'s 2-week prune default
   (https://git-scm.com/docs/git-gc): nothing unfetched is destroyed.
3. **Only when the check actually fails in one of the three recreate-worthy
   ways**: missing mount, missing clone, or missing clone-mode remote
   (`src/doctor.ts` lines 359–397). A healthy sandbox is never recreated.
4. The recreate itself uses `sbx rm --force NAME` (sbx's own flag), so the
   outer `--force` and the inner one align.

## Options for the design

**Option A: fix actions as data on each check.** Each `Check` gets an optional
`fix?: (deps, ctx) => string | null` (returns a human note, or null on
nothing-to-do). `doctor --fix` runs fixes for `fail`/`warn` results in the
fixed order, then re-runs all checks and prints them.

**Option B: a separate `oc-sub update` command.** brew's split (doctor never
fixes; `brew update`/`brew cleanup` repair). New command, no coupling to the
check registry.

**Option C: fix actions as named top-level commands only** (`oc-sub plugin
update`, `oc-sub sandbox recreate`), with `--fix` just printing which command
to run.

| Criterion | A. fix on the check | B. `update` command | C. named commands only |
|---|---|---|---|
| 1 agent-safe, no prompt | Pass: flag/precondition guards, no stdin. | Pass. | Pass, but the agent must run several commands. |
| 2 blast radius | Pass: sandbox fix requires `--force` and preconditions; the others are safe. | Pass, but nothing ties the destructive command to the check that found the problem. | Pass; the guard lives where the command lives. |
| 3 established patterns | Pass: eslint/npm/cargo shape (flag on the diagnose command), `--force` for destructive. | Pass: brew shape. | Partial: more commands than any surveyed tool has. |
| 4 transparent | Pass: prints each action before running it and re-runs checks. | Pass. | Pass. |
| 5 small steps, testability | Pass: one pure-ish function per check next to the existing registry, fakes as in `test/sandbox.test.ts`. | Moderate: new command surface, arg parsing, state. | Largest: several new commands. |
| 6 ordering | Pass: one fixed order in one place; re-run built in. | Weak: the user must know the order (plugin update → restart). | Weak: same. |
| Failure modes | A stale fix action can drift from its check text (mitigated: the fix text stays the display text; the action is separate). One broken action should not stop the others (catch per action). | The command drifts from the checks: new check, no update step. | Agents skip steps; the one-command goal of step 15 is lost. |

Option A wins on criteria 5 and 6 and matches the step-15 goal of "one command
brings the setup up to date". It keeps `doctor` diagnose-only by default
(criterion 3), which B also satisfies, but B and C lose criterion 6 because
the ordering knowledge leaves the tool.

## Recommendation

Implement Option A in `src/doctor.ts`:

1. **Type**: extend the registry with an optional fix action per check:

   ```ts
   type FixOutcome = { ok: boolean; note: string };
   type Check = {
     name: string;
     run: (deps: DoctorDeps) => CheckResult;
     // Runs only when --fix is set and the check is warn or fail.
     // ctx.force is the --force flag; the action returns ok=false with a
     // reason when a precondition (busy session, unfetched work) blocks it.
     fix?: (deps: DoctorDeps, ctx: { force: boolean }) => Promise<FixOutcome>;
   };
   ```

   The fix text of the `CheckResult` stays the display text and the plan line.

2. **Which fixes need `--force`**:
   - `plugin-fresh`: no. Runs `claude plugin marketplace update
     opencode-subagents && claude plugin update opencode-subagents@...`
     through an injected runner. Skip when the check is `skip` (no cache
     entry).
   - `global-rules`: no. A copy becomes a symlink **only when its content
     equals the shared file** (read both, compare); otherwise the fix reports
     "content differs, not changed" and the check stays failed. A missing
     rule file is not created (the tool may not be installed); a broken link
     is re-pointed with `ln -sfn` semantics (unlink + `symlink`).
   - Server restart after a plugin update: no `--force`, but only when the
     server is idle (same busy check as `down`, all sessions idle) and the
     plugin fix actually changed something; implemented as the `plugin-fresh`
     fix's second step (update → restart idle server), not as a separate
     check fix.
   - `sandbox-mounts`: **yes, `--force` required**, plus the preconditions of
     Section 6: no busy session (skippable only by the same `--force` that
     enables the fix — so busy sessions abort the recreate and name
     `oc-sub down`/`abort`), and no unfetched `feature/*` commits in the clone
     (fetch `sandbox-<name>`, compare against `alpha`, abort with the review
     command). Then `sbx rm --force NAME` and `oc-sub up`.

3. **Order**: `plugin-fresh` (with its restart) → `global-rules` →
   `sandbox-mounts`. That is also the order of `SLOW_CHECKS` plus the fast
   file fixes; fix actions attach to the existing checks, and the runner
   iterates `ALL_CHECKS` in order, so no separate ordering table exists.

4. **Output**: one line per action before it runs
   (`fixing plugin-fresh: <command>`), one line after
   (`fixed plugin-fresh: <note>` or `fix failed (global-rules): <reason>`),
   then the full re-run of `ALL_CHECKS` printed as today. `--json` prints the
   re-run results with an added `fixes` array (`{name, ok, note}`).

5. **Exit code**: 0 when the re-run has no `fail`; 1 otherwise, including
   when a fix action failed and the check is still broken. Warns do not fail,
   except a failed fix action on a warn-level check (`plugin-fresh`), which
   forces that check's re-run result to `fail` — a fix that errors is a
   problem, not a warning.

## Open questions

- Whether the restart after a plugin update should be part of the
  `plugin-fresh` fix (proposed) or its own pseudo-check with its own fix —
  part of the fix keeps the ordering trivial, but the restart then cannot run
  when the plugin was already fresh and only the server is stale. A check for
  a stale server does not exist yet; if one is added later, it needs its own
  fix.
- Whether `global-rules` should re-point a broken symlink whose target is a
  *different* existing file (proposed: yes, after the content-equals check on
  the file it points to), and whether it should create the parent folders
  (proposed: no; report instead).
- The exact shape of the busy-session list for the restart guard: `down` reads
  a `dirs` state file; `doctor --fix` needs the same directories for the
  sandbox project (open follow-up of step 14, `readDirs` in `src/down.ts`).
- Whether `--fix` should also run when a check is `error`-level in a future
  status model (DOCTOR.md proposes an `error` status); today the statuses are
  `pass | warn | fail | skip`.

## Search log

- Read first: `~/dv/meta/agents/lessons/` (19 lessons) and
  `~/dv/meta/agents/research-index.md` — relevant:
  `claude-plugin-fixed-version-never-updates.md` (why the plugin check
  compares SHAs), `sbx-clone-mode-fails-silently.md` and
  `sbx-stop-removes-clone-remote.md` (why the recreate preconditions exist),
  `opencode-config-dir-drops-global-agents-md.md` (why the rules are passed
  as absolute paths).
- `websearch`: "npm audit fix --force behavior documentation package-lock
  destructive" — 5 relevant hits (npm docs v10/v11/v6, npm/cli source).
- `websearch`: "eslint --fix --fix-dry-run documentation warnings not fixed"
  — 5 relevant hits (eslint CLI reference current and archived, eslint
  discussion #15668, issue #9739).
- `websearch`: "brew cleanup --dry-run -n documentation prune all versions
  formula" — 4 relevant hits (brew FAQ, brew rubydoc CleanupSubcommand with
  the `Ask.confirm?` TTY guard, brew analytics, deepclean.app examples).
- `websearch`: "yarn dedupe --check documentation exit code; cargo fix
  --allow-dirty --allow-no-vcs documentation" — 4 relevant hits (yarnpkg CLI
  docs v4/v3, Cargo Book cargo-fix, Debian manpage).
- `websearch`: "git gc --prune=now --unsafe refuse prune repositories have
  garbled refs documentation" — 5 relevant hits (git-scm git-gc docs, versions
  2.43/v2.55 source docs).
- `websearch`: "\"brew doctor\" does not fix problems diagnostic only manual
  remediation; rustup self update command" — 4 relevant hits (brew
  Troubleshooting, brew Common-Issues, homebrew-core issue #178311, rustup
  self_update.rs source).
- `websearch`: "rustup self update documentation self update rustup book
  self-update" — 3 relevant hits (rustup book basics, FAQ, self_update.rs).
- Not searched again (already covered by DOCTOR.md §1 with sources): flutter
  doctor (no fix mode), mise doctor (hint text never executed), npm doctor,
  Laravel doctor.

## Review of the main thread (2026-09-30)

The main thread accepts option A with these changes.

1. Cost. The run cost 0.0112 USD at OpenRouter, not 0.00 USD. The header is corrected.
2. The guard of the sandbox recreate. `--force` enables the destructive fix class and nothing else. A busy session and unfetched `feature/*` commits always block the recreate, also with `--force`. There is no "`--force` twice". The user ends or fetches the work first, then runs `doctor --fix --force` again. This follows the plan of step 15c.
3. The restart after a plugin update is not part of the `plugin-fresh` fix. The server takes its plugin folder from the `oc-sub` that started it (`PLUGIN_CONFIG_DIR` in `src/up.ts`). On this machine `~/.local/bin/oc-sub` links to the development checkout, so a plugin update does not change the folder of the server at all. A restart helps only when the plugin folder of the running server differs from the current one. So the restart gets its own check with its own fix (open question 1, second answer). That check needs the plugin folder of the running server in the state files, so it is a later step (15c).
4. In sandbox mode the plugin folder is a mount of the sandbox. If the folder of the plugin changes (for example, a new commit folder in the plugin cache), `sandbox-mounts` fails and the fix is a recreate, not a restart. This makes the recreate more common than the plan assumed. A stable plugin path (for example a symlink that always points to the current plugin folder) avoids it. This is an open question for the user.
5. No `--dry-run` for now, as the report proposes. `doctor` without `--fix` is the dry run.
6. `--fix` never prompts, with or without a terminal.

Split of the work:

- 15b: the fix framework (the optional `fix` action on a check, `--fix`, `--force`, the plan lines, the re-run, the exit code, `fixes` in `--json`), the `plugin-fresh` fix, and the `global-rules` fix.
- 15c: a check for a stale server plugin folder, and the restart of an idle server as its fix.
- 15d: the sandbox recreate with `--fix --force` and the preconditions of section 6.
