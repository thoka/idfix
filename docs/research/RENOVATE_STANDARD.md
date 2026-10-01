# Research: how tools define a standard, detect drift, and apply migrations

Date: 2026-10-01. Worktree `r15e-renovate`, branch for step 15e (`doctor --renovate`).
Extends [DOCTOR.md](DOCTOR.md) and [DOCTOR_FIX.md](DOCTOR_FIX.md). Cost: web search
only, no paid API calls.

Question: how do established tools (1) define the current standard, (2) detect
that a project lags behind it, (3) order and version migrations, (4) keep a
migration safe, and (5) report a migration that needs a human? Then: which
design choices does `doctor --renovate` have, and what are their pros and cons?

## Criteria

From the Values of the global rules and the brief:

1. **No prompt, agent-safe** — like `--fix` (DOCTOR_FIX.md §2), `--renovate`
   must never block on stdin.
2. **Blast radius small by default** — destructive changes need an explicit
   flag and preconditions, never a prompt.
3. **State lives in the project, not in a hidden cache** — a new thread or a
   new machine must be able to see what the project lags behind and by how
   much.
4. **Idempotent and re-runnable** — the tool detects the drift each time or
   stores applied steps, so a repeat run either does nothing or continues.
5. **Transparent** — the tool prints what it changes and reports what it
   could not change, with a fix note (DOCTOR.md §1: the `fix`/`hint` pattern).
6. **Small steps and testability** — each migration is a small injected
   function next to the check registry in `src/doctor.ts`, like the fix
   actions of step 15b–15d.

## 1. Prior art: how tools define the standard and detect drift

The surveyed tools fall into three families:

| Family | Tools | How the standard is defined | How drift is detected |
|---|---|---|---|
| Migration list from the tool, keyed by version | `ng update`, `nx migrate`, `@next/codemod`, Rails `app:update` | Each tool release ships code migrations with a `version` field. | Compare the version in the project (`package.json`, `Gemfile.lock`) to the target version; run every migration whose version is in between. |
| Internal config migration on every run | Renovate config migration | The migration code ships with Renovate itself; legacy config keys keep working after an internal rewrite. | Detect each run: migrate internally, log a debug message, and offer a config-migration PR. |
| State file that records the applied template version | copier, cruft | The template repository (and its git tags/commits) is the standard. | A answers/state file (`.copier-answers.yml`, `.cruft.json`) records the template commit the project was generated from; `copier update` / `cruft update` compare it to the latest tag or commit. |

Facts with sources:

- **Angular `ng update`**: each npm package ships a `migrations.json`
  (or an `ng-update.migrations` entry in its `package.json`) whose schematics
  each carry a `version` and a `factory` path
  (https://github.com/IgniteUI/igniteui-angular/wiki/Update-Migrations, read
  2026-10-01: "Schematic(s) that match the updated package version (and any
  intermediate versions) will be run as part of `ng update <pkg>`"). The CLI
  reads the target and installed versions and runs the migrations in between
  (https://angular.dev/cli/update, read 2026-10-01: `from`/`to` options
  describe exactly this window; "Default to the installed version detected").
- **Nx `migrate`**: a two-phase design. Phase 1 `nx migrate <pkg@version>`
  edits `package.json` and *generates* a `migrations.json` file listing the
  pending migrations, without touching source. Phase 2
  `nx migrate --run-migrations` applies them
  (https://nx.dev/docs/features/automate-updating-dependencies, read
  2026-10-01: "1. Generate ... No source code is touched yet. 2. Run ... runs
  the generated migrations"). Each plugin ships migration generators with a
  `packageVersion` (https://nx.dev/docs/extending-nx/migration-generators,
  read 2026-10-01). The user can edit, reorder, skip, or re-run entries in
  `migrations.json` (https://nx.dev/docs/guides/tips-n-tricks/advanced-update,
  read 2026-10-01). Nx also supports prompt-based, AI-aided migrations, with
  one commit per migration in the agentic flow (same page).
- **Renovate config migration**: the migration code lives in Renovate. "The
  migration code allows 'legacy' config from users to keep working. Config
  migration works by migrating legacy config internally, before the config is
  used" (https://docs.renovatebot.com/config-migration/, read 2026-10-01).
  Detection is per run, not per stored version. An opt-in `configMigration`
  option (default `false`,
  https://docs.renovatebot.com/configuration-options/) makes Renovate raise a
  pull request that rewrites the config with current option names. The
  standalone validator `renovate-config-validator --strict` fails when "config
  migration necessary" (https://github.com/renovatebot/renovate/blob/main/docs/usage/config-validation.md,
  read 2026-10-01), so drift detection is a separate checkable command.
- **`@next/codemod`**: named codemods grouped by Next.js version; the
  `upgrade` subcommand runs the whole upgrade (packages plus recommended
  codemods) and accepts `--dry` for a dry run and `--yes` (auto-enabled when
  stdin is not a TTY) to skip prompts
  (https://nextjs.org/docs/app/guides/upgrading/codemods, read 2026-10-01:
  "`--dry` Do a dry-run, no code will be edited"; "Also auto-enabled when
  stdin is not a TTY (CI, an AI coding agent, or any non-interactive shell)").
  Individual codemods are runnable by name at any time.
- **Rails `bin/rails app:update`**: no version bookkeeping at all. It re-runs
  the same generator code path as `rails new` and, for every file that
  differs, asks the user with a Thor conflict prompt (`Ynaqdhm`: overwrite,
  skip, all, quit, diff, help, merge)
  (https://guides.rubyonrails.org/upgrading_ruby_on_rails.html, read
  2026-10-01, and https://www.joshmcarthur.com/til/2019/07/25/upgrading-rails-apps-with-rake-appupdate.html,
  read 2026-10-01). It creates *new* files (for example
  `new_framework_defaults_8_0.rb`) and lets the user review; drift detection
  is the file-by-file comparison, done interactively.
- **copier**: requires a valid `.copier-answers.yml` in the project, a
  git-versioned template, and a git-versioned destination
  (https://copier.readthedocs.io/en/v9.7.0/updating/, read 2026-10-01).
  Update algorithm: regenerate a fresh project from the *old* template version
  and from the new one, compute "fresh-old → project" (the user's own edits)
  and "fresh-old → fresh-new" (the template's changes) as diffs, apply
  pre-migrations, apply the template diff, then post-migrations. Conflicts
  become inline conflict markers or `.rej` files. The answers file holds
  `_commit` and `_src_path`, which is the recorded state.
- **cruft**: stores `{template, commit, checkout, context, skip}` in
  `.cruft.json` (https://cruft.github.io/cruft/reference/cruft/, read
  2026-10-01). `cruft check` compares the recorded commit to the template
  HEAD and is meant for CI
  (https://github.com/cruft/cruft, read 2026-10-01: "cruft can quickly
  validate whether or not a project is using the latest version of a template
  ... This check can easily be added to CI pipelines"). `cruft update`
  refuses on an unclean git tree and regenerates old and new template outputs
  to compute a diff.

`brew doctor` (already covered in DOCTOR.md §1) is the diagnose-only model:
it defines no standard version and reports only; the fixing is manual. It is
the baseline that `--renovate` must improve on.

## 2. How they order and version migrations

Two models:

- **State model (store the applied version)**: the project holds the state.
  - copier and cruft store the template commit in `.copier-answers.yml` /
    `.cruft.json` (sources above). The state is a git-tracked file, so every
    branch and clone carries it.
  - `ng update` and `nx migrate` store no per-migration marker; the version
    numbers in `package.json` (or the dependency lockfile) act as the state:
    the installed version *is* "migrations up to here applied". Nx's
    `migrations.json` is a plan file, not a ledger — it is meant to be deleted
    after the run (https://nx.dev/docs/guides/tips-n-tricks/advanced-update:
    "After you run all the migrations, you can remove `migrations.json`").
- **Stateless model (detect from the files each run)**: Renovate config
  migration and Rails `app:update` store nothing. Renovate re-runs the
  internal migration on every run and only signals that a PR would help;
  Rails re-derives the drift from the file-by-file diff against the
  generators. This works because their migration is idempotent by design.
  Nx `--run-migrations` is also re-runnable, but only while
  `migrations.json` exists.

Ordering: `ng update` and Nx order migrations by their `version` fields and
apply the window from the installed to the target version, including all
intermediate versions (IgniteUI wiki source above: "each schematic should
only migrate changes made in that specific version"). Renovate's internal
migrations are applied as a fixed pipeline of rewriters in one pass. copier's
order is fixed by its algorithm (pre-migrations, template diff,
post-migrations).

For `oc-sub`: the checks of `src/doctor.ts` already detect the drift from the
files (an old sandbox, a project opencode pin, a stale server digest), so the
stateless model fits and needs no state file. The re-run of checks after the
fix pass (DOCTOR_FIX.md §4) already proves idempotence.

## 3. How they keep a migration safe

| Guard | Tools | Source |
|---|---|---|
| Dry run | `@next/codemod --dry`; `brew cleanup --dry-run` (DOCTOR_FIX.md §1); Renovate's own dry-run global config; copier `--dry` and cruft `--skip-update` (the plan/diff is shown, nothing is written). | https://nextjs.org/docs/app/guides/upgrading/codemods; https://copier.readthedocs.io/en/v9.7.0/updating/ |
| Clean git tree as precondition | `ng update` refuses on a dirty or untracked repo by default (`allow-dirty`, "Value Type boolean, Default false" — https://angular.dev/cli/update, read 2026-10-01); `cargo fix --allow-dirty` (DOCTOR_FIX.md §1); cruft update: "Cruft cannot apply updates on an unclean git project" (https://cruft.github.io/cruft/reference/cruft/); copier requires the destination folder to be git-versioned and clean ("`git status` shows it clean" — https://copier.readthedocs.io/en/v9.7.0/updating/). | — |
| One commit per migration | `ng update --create-commits` (https://angular.dev/cli/update: "Create source control commits for updates and migrations. Default false"); `nx migrate --run-migrations --create-commits`, with `commitPrefix` and defaults in `nx.json` (https://nx.dev/docs/guides/tips-n-tricks/advanced-update; https://github.com/nrwl/nx/blob/03483ea2/packages/nx/src/command-line/migrate/command-object.ts, read 2026-10-01); Nx agentic flow commits per migration for agent review (https://nx.dev/docs/features/automate-updating-dependencies). | — |
| Two-phase plan | `nx migrate` (generate `migrations.json`, then `--run-migrations`), which gives a reviewable plan before any write. | https://nx.dev/docs/features/automate-updating-dependencies |
| No backup; git is the backup | None of the surveyed tools makes file backups; the clean-tree precondition plus commits is the recovery path. copier's `.rej` files are the only artifact-style fallback, and its own docs' comparison calls that out as a failure mode ("the original file stays unchanged, even if the update partially fails ... cruft still updates the commit hash" — https://www.blenddata.nl/en/blogs/cruft-vs-copier-automating-template-updates-at-scale, read 2026-10-01). | — |
| Confirmation | Rails prompts per file; copier prompts for answers and for applying changes; all three prompt only on a TTY. `@next/codemod` and Nx's agentic flow auto-accept or run non-interactively without a TTY. | sources above |

Converging pattern: **the safety comes from git, not from the tool** — a clean
tree precondition, a dry-run or plan phase, and an opt-in commit per step.
Prompts appear only on a TTY.

## 4. How they report a migration that needs a human

- **`@next/codemod`**: a codemod that cannot transform a spot safely inserts a
  marker into the code: "the codemod will either add a typecast (if a
  TypeScript file) or a comment to inform the user that it needs to be
  manually reviewed & updated. These comments are prefixed with `@next/
  codemod`, and typecasts are prefixed with `UnsafeUnwrapped`"
  (https://nextjs.org/docs/15/app/guides/upgrading/codemods, read 2026-10-01).
  The marker is a grep-able TODO in the file it touched.
- **Nx**: prompt-based migrations are skipped without an agent and "the
  skipped prompt files are listed in the next-steps output, in order, so you
  can apply them yourself" (https://nx.dev/docs/features/automate-updating-dependencies,
  read 2026-10-01).
- **Renovate**: it does not fix what it must not rewrite; it raises a pull
  request and puts a checkbox on the Dependency Dashboard, and the PR body
  says the legacy config "will continue to work" until the migration is
  removed (https://docs.renovatebot.com/config-migration/, read 2026-10-01).
  The human action is the merge of a reviewable PR.
- **Rails**: every ambiguous file is a conflict prompt with a `d` (diff) and
  `m` (merge tool) option (guides above).
- **copier**: unresolved diff hunks become inline conflict markers in the
  file, the format a developer already knows from git merge.
- **`ng update`**: no marker mechanism documented; a failed migration leaves
  the workspace for manual fixes (not documented on the reference page — open
  point).

Converging pattern: the tool writes a **grep-able marker into the file it
touched** (Next.js, copier), or reports a **reviewable artifact** (Renovate's
PR, Nx's next-steps list), and never silently succeeds.

## 5. Design choices for `doctor --renovate`

The candidate migrations are known from the brief: (a) a host-mode server
instead of a sandbox, (b) a sandbox without clone mode, (c) a project
`mise.toml` pinning its own opencode, (d) old copies of agent files. The
check registry in `src/doctor.ts` already detects (a)–(d) or close variants
of them; `--renovate` is a fix pass plus migration-specific additions.

### Choice 1: stateless re-detect vs state file

| Criterion | A. Stateless (detect from files each run) | B. State file in the project (`.oc-sub.json` with applied versions) |
|---|---|---|
| 1 agent-safe | Pass. | Pass. |
| 2 blast radius | Pass. | Pass. |
| 3 state in the project | Pass: the project files *are* the state (like Renovate, Rails). | Pass (like copier/cruft), but adds a file the user must learn. |
| 4 idempotent | Pass only if each migration is idempotent and reversible — must hold per migration. | Pass; a version field makes skips explicit. |
| 5 transparent | Pass: the doctor report shows the drift. | Pass; also survives partial runs. |
| 6 small steps | Pass: reuses `ALL_CHECKS` as-is. | Cost: a schema, a version bump procedure, and the risk of a stale file. |
| Failure modes | A non-idempotent migration runs twice on re-run (must be written idempotently, like the existing fixes). A partially failed run looks like the original drift; the re-run of checks shows what remains (DOCTOR_FIX.md §4). | The state file drifts from reality (copier docs warn: never edit the answers file by hand — https://copier.readthedocs.io/en/v9.7.0/updating/). Extra file in every project. |

Stateless (A) fits, because oc-sub's migrations are all "make the files
current", not "apply history in order" — no oc-sub change has a step that
depends on an earlier oc-sub version having run. Criteria 4 and 6 decide for
A.

### Choice 2: two-phase plan vs single pass

| Criterion | A. Single pass (like `--fix` today, one line per action, then re-run checks) | B. Two-phase like `nx migrate` (print a plan, ask to apply) |
|---|---|---|
| 1 agent-safe | Pass. | A prompt blocks agents; must fall back to non-interactive (Nx's non-TTY behaviour). |
| 2 blast radius | Pass with the existing `--force` guards. | Pass. |
| 3 | Pass. | Pass. |
| 4 | Pass (re-run). | Pass. |
| 5 | Pass: the diagnose-only `doctor` is already the dry run (DOCTOR_FIX.md §5, review note 5). | Pass, but a second flag surface. |
| 6 | Pass. | Cost: plan/apply split, more flags. |

A decided this: `doctor` without `--fix`/`--renovate` already prints the
plan as the fix text of every finding (the pattern of `brew bundle cleanup`,
DOCTOR_FIX.md §1). The re-run of checks after the pass is the built-in
verification.

### Choice 3: what each migration reports when it needs a human

| Criterion | A. Fail the check, print a fix note naming the manual step | B. Write a marker into the touched file (Next.js style) |
|---|---|---|
| 1 | Pass. | Pass. |
| 2 | Pass: the tool never invents content it must not create (like `globalRulesFix` refusing to create a missing rule file, `src/doctor.ts` lines 518–524). | Pass. |
| 3 | Pass. | Pass, but the marker pollutes project files; a checked-in file marker is a change the user did not ask for. |
| 4 | Pass: exit code non-zero, re-run shows the remaining fail. | Pass. |
| 5 | Pass: the existing `fix failed (<name>): <note>` line (DOCTOR_FIX.md §5). | Pass. |
| 6 | Pass. | Pass. |

A decided: oc-sub's fixes already have the "fail with note" shape, and no
oc-sub migration edits user source files where a marker would live.
`agent-copies` with differing content is the canonical human case: like
`globalRulesFix`, it must not delete a file with unmerged content (criterion
2, and the same rule as DOCTOR_FIX.md §6 for the recreate).

### Choice 4: one commit per migration vs one pass, one review

| Criterion | A. No commits by `--renovate`; clean tree is the precondition, git shows the whole diff | B. `--create-commits` opt-in, one commit per migration (ng update / Nx pattern) |
|---|---|---|
| 1 | Pass. | Pass. |
| 2 | Pass. | Pass. |
| 3 | Pass. | Pass. |
| 4 | Pass. | Pass. |
| 5 | Pass: one diff to review. | Pass: per-step diffs. |
| 6 | Pass. | Cost: commit authorship, prefix, and branch state; and the "alpha" merge model of this project expects one squash per feature anyway (global rules, Git section). |

A decided as the default; B is cheap to add later with the same flag name as
the prior art (`--create-commits`) if the user wants it.

### Clean-tree precondition

All surveyed write-tools with a git repo guard it (`ng update` default,
cargo, cruft, copier). `doctor --fix` so far fixes files outside the project
(symlinks, sandbox), so it never needed this. `--renovate` writes project
files (a `mise.toml` pin, agent files), so it should adopt the guard: refuse
on a dirty tree, print the guard, and allow `--force` — the same
"precondition, not prompt" pattern as DOCTOR_FIX.md §2.

## Recommendation

1. `--renovate` runs as an alias of the fix pass over `ALL_CHECKS` (choice 2,
   A), with the clean-tree precondition when any fix would write inside the
   project (choice from §5 end), and `--force` unchanged from step 15d.
2. New migrations (project opencode pin, old agent copies) are new fix
   actions on their existing checks, written idempotently, each returning
   `ok: false` with a note when it must not act (choice 3, A).
3. No state file (choice 1, A), no commits by default (choice 4, A); the
   re-run of checks decides the exit code, as today.
4. Open: whether the project `mise.toml` opencode pin should be rewritten
   automatically (it changes a file the user owns; the note may have to name
   the edit instead of making it) — this belongs to the user, per the global
   rule that user configuration changes are the user's decision.

## Open questions

- The exact shape of a "project `mise.toml` pins opencode" migration: auto-edit
  vs report-only (a user-decision question, see Recommendation 4).
- `ng update` behaviour when a migration itself fails (rollback? partial
  application?) is not documented on the reference page read; unknown what to
  copy there. Tried: the `angular.dev/cli/update` reference page.
- Whether Rails `app:update` has gained a non-interactive mode since 2024
  (the guides read still show the interactive prompt only). Tried: the Rails
  upgrading guide and the 2024 commit that turned the task into a command;
  no non-interactive flag found there.

## Search log

- `websearch`: "ng update migrations schematics how Angular detects outdated
  packages migrations.json UPDATE-MIGRATIONS" — 5 relevant hits (IgniteUI
  migration wiki, angular-cli commit a949e06 with the disk-fallback
  migration discovery, update schematic spec, angular-cli issue #33717,
  angular PR #29705).
- `websearch`: "Nx migrate migrations.json how it works generator runs nx
  migrate --run-migrations" — 5 relevant hits (nx.dev migration-generators,
  automate-updating-dependencies, tips-n-tricks/advanced-update, the migrate
  CLI reference mirror, the `command-object.ts` source).
- `websearch`: "Renovate config migration renovate deprecated preset manager
  documentation" — 5 relevant hits (docs.renovatebot.com config-migration,
  configuration-options, upgrade-best-practices, config-validation.md, and
  the `ensureConfigMigrationPr` source).
- `websearch`: "\"npx @next/codemod\" next.js codemod upgrade latest how it
  works list codemods" — 5 relevant hits (nextjs.org codemod guides for
  v15/16 and the version-16 upgrade guide).
- `websearch`: "Rails \"app:update\" rake task rails app:update diff
  templates what it does" — 5 relevant hits (Rails upgrading guide, two
  practitioner notes, the 2024 rails commit that made it a command).
- `websearch`: "copier cruft template version tracking .releaser .cruft.json
  update diff how stored" — 5 relevant hits (cruft reference, cruft README,
  copier updating + creating docs, a cruft-vs-copier comparison blog with the
  `.rej` failure mode).
- `reader` (1 call): https://angular.dev/cli/update — the `allow-dirty`,
  `create-commits`, `from`/`to` option wording.
