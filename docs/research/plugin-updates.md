---
checked: 2026-09-30
recheck: on new Claude Code release
decisions:
  - "the synced plugin folder of step 15c"
---

# Research: Why an installed Claude Code plugin does not get new features

Date: 2026-09-30. Scope: how Claude Code decides that an installed plugin has an
update, why this plugin (`opencode-subagents`, version `"0.1.0"`, marketplace
`thoka/opencode-subagents`) stayed at an old commit despite 67 new commits, and
what the plugin author should do.

## Situation in this repository

- `.claude-plugin/plugin.json` sets `"version": "0.1.0"` (line 3).
- `.claude-plugin/marketplace.json` has `"source": "./"` (line 10) — the
  marketplace entry sets **no** version of its own.
- The installed copy is cached at
  `~/.claude/plugins/cache/opencode-subagents/opencode-subagents/0.1.0/`,
  pinned at an old git commit. 20 commits are not even pushed yet, so no
  update mechanism on any other machine can ever see them.

## 1. How does Claude Code decide that a plugin has an update?

It compares a **version string**, not content and not directly the commit. The
version is resolved from the first of these that is set (plugins-reference):

1. the `version` field in `plugin.json`,
2. the `version` field in the marketplace entry in `marketplace.json`,
3. the git commit SHA of the plugin source (for `github`, `url`, `git-subdir`,
   and relative-path sources in a git-hosted marketplace),
4. `unknown` (npm sources, local directories outside a git repo).

> "Claude Code uses the plugin's version as the cache key that determines
> whether an update is available. When you run `/plugin update` or auto-update
> fires, Claude Code computes the current version and skips the update if it
> matches what's already installed."
> — https://code.claude.com/docs/en/plugins-reference (Version management;
> mirrored text at https://github.com/pleaseai/claude-code-docs/blob/4786a555/docs/plugins-reference.md)

> "Plugin versions determine cache paths and update detection: if the resolved
> version matches what a user already has, `/plugin update` and auto-update
> skip the plugin."
> — https://code.claude.com/docs/en/plugin-marketplaces

If the version does not change, the update is a no-op and the CLI reports
"already at the latest version". The cache directory itself is versioned:
`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` — which is exactly
the `0.1.0/` directory in the situation above. This repo is the "Explicit
version" failure mode:

> "Set `"version": "2.1.0"` in `plugin.json` ... Users get updates only when
> you bump this field. Pushing new commits without bumping it has no effect,
> and `/plugin update` reports 'already at the latest version'."
> — https://code.claude.com/docs/en/plugins-reference

So: 67 new commits with `version` still `"0.1.0"` are invisible by design.
The commit SHA is recorded (`gitCommitSha` in `installed_plugins.json`) but it
is not the update trigger when an explicit version exists.

Known bugs in this area (mostly reported as fixed in recent releases):
`/plugin marketplace update` not pulling the clone (#10182, #35752) and the
update path reading a stale marketplace clone (#83777, reported fixed on
current releases — reinstall once if the cache is already corrupted).

## 2. Which commands update it, and is there auto-update?

Commands:

- `claude plugin marketplace update <name>` (or `/plugin marketplace update`)
  refreshes the marketplace catalog: "Refresh marketplaces from their sources
  to retrieve new plugins and version changes" —
  https://code.claude.com/docs/en/plugin-marketplaces
- `claude plugin update <plugin>@<marketplace>` then updates the installed
  plugin: "Update a plugin to the latest version" —
  https://code.claude.com/docs/en/plugins-reference
- `/plugin` → *Marketplaces* tab → *Update marketplace* does the same in the UI.

Auto-update:

> "Claude Code can automatically update marketplaces and their installed
> plugins at startup. When auto-update is enabled for a marketplace, Claude
> Code refreshes the marketplace data and updates installed plugins to their
> latest versions. If any plugins were updated, you'll see a notification
> prompting you to run `/reload-plugins`."
> — https://code.claude.com/docs/en/discover-plugins (Configure auto-updates)

> "Official Anthropic marketplaces have auto-update enabled by default.
> Third-party and local development marketplaces have auto-update disabled by
> default."
> — same page

So for a third-party GitHub marketplace like `thoka/opencode-subagents`,
auto-update is **off by default**. It can be enabled:

- per user, in the UI: `/plugin` → Marketplaces → select → *Enable auto-update*
  (same page), or
- via settings: `"autoUpdate": true` on an `extraKnownMarketplaces` entry —
  https://code.claude.com/docs/en/settings#extraknownmarketplaces.

Environment knobs: `DISABLE_AUTOUPDATER=1` disables all auto-updates;
`FORCE_AUTOUPDATE_PLUGINS=1` keeps plugin auto-updates while Claude Code
itself is updated manually (https://code.claude.com/docs/en/discover-plugins).
Caveat: background auto-update of private HTTPS marketplaces has known auth
problems (it disables credential helpers; see
https://code.claude.com/docs/en/plugin-marketplaces). This repo is public, so
that does not apply.

## 3. Local marketplaces and `--plugin-dir`

A marketplace entry may point to a relative local path (`"source": "./"` means
the plugin files are the marketplace repo itself); paths are relative to the
marketplace root, and `..` paths are rejected by `claude plugin validate`
(https://code.claude.com/docs/en/plugin-marketplaces).

Crucially, the behaviour differs between "added as a local directory" and
"installed from a hosted marketplace":

> "With that setup, Claude Code reads the plugin's files directly from
> `my-marketplace/plugins/`. Your edits take effect at the next session start
> or when you run `/reload-plugins` in a session, with no change to the
> plugin's `version`. People who install from your hosted marketplace get a
> copy in the plugin cache instead."
> — https://code.claude.com/docs/en/plugin-marketplaces (Test an edit to a plugin)

> "A plugin ... loaded in place from a marketplace added as a local directory
> [isn't] pinned by this field [version]."
> — https://code.claude.com/docs/en/plugins-reference

So: **if the author adds their own marketplace by local path, the files are
read live** — no cache copy, no version bump needed, changes appear after
`/reload-plugins` or a session restart. But **users who install the same
marketplace from GitHub get a cached copy** and are subject to version-gated
updates.

For development without a marketplace, `claude --plugin-dir <dir>` loads a
plugin directly from a directory (no marketplace, no cache; the plugin name
comes from the directory name) —
https://code.claude.com/docs/en/plugins-reference and
https://code.claude.com/docs/en/plugins/create#develop-without-a-marketplace.

Note: this repository's own install in the situation described came from
GitHub (`thoka/opencode-subagents`), hence the cached, version-pinned copy —
even on the author's machine.

## 4. Recommended practice for the plugin author

The docs describe exactly two versioning strategies:

| Approach | Behaviour | Best for |
| --- | --- | --- |
| Explicit `version` | Updates only on a version bump | Published plugins with stable release cycles |
| Omit `version` | Every new commit counts as a new version (commit SHA used) | Internal / actively developed plugins |

Sources: https://code.claude.com/docs/en/plugins-reference (Version management)
and https://code.claude.com/docs/en/plugin-marketplaces:

> "For the git-based source types `github`, `url`, `git-subdir`, and relative
> paths inside a git-hosted marketplace, you can omit `version` entirely and
> every new commit is treated as a new version. This is the simplest setup for
> internal or actively-developed plugins."

Practical advice derived from this (partly unverified beyond the docs):

- **On the machine where you develop**: add the marketplace by local path
  (`/plugin marketplace add /path/to/repo`) or use `--plugin-dir`. Files are
  read live; no version bookkeeping at all (verified by docs quote in §3).
- **On other machines installing from GitHub**: either omit `version`
  everywhere (updates on every pushed commit — good while the plugin is under
  daily development), or keep an explicit version but bump it on *every*
  release. Pushing commits without a bump does nothing (§1).
- A "release branch" is not a documented mechanism for this; a marketplace
  entry can pin a `ref` (branch/tag/commit), which pins *all* its users to
  that ref — useful for stability, not for daily updates
  (https://code.claude.com/docs/en/plugin-marketplaces). [Unverified: whether
  an entry can point at a branch and still auto-update within that branch —
  the docs say a marketplace added with a ref "updates to the latest commit of
  that ref", so this appears to work at marketplace level.]
- Existing installs that are stuck: `claude plugin marketplace update <name>`
  then `claude plugin update <plugin>@<marketplace>`; if the cache is already
  inconsistent, uninstall → marketplace update → install
  (https://github.com/anthropics/claude-code/issues/72162, #83777).

## 5. Restart or `/reload-plugins` after an update?

Yes — an update does not affect the running session by itself:

- `claude plugin update` prints "Restart to apply changes" (update op message;
  see https://github.com/xqliang/claude-code/blob/4b9d30f7/src/services/plugins/pluginOperations.ts,
  `"message": ... "Restart to apply changes."`).
- `/plugin install` is documented to be followed by `/reload-plugins`:
  "After installing, run `/reload-plugins` to activate the plugin" —
  https://code.claude.com/docs/en/discover-plugins.
- Auto-update: "you'll see a notification prompting you to run
  `/reload-plugins`, or the new versions load on your next launch" —
  https://claude-code.mintlify.app/en/discover-plugins (mirror of the docs page).

Caveat: in some versions a running session kept executing the old cache copy
even after a successful update plus two `/reload-plugins` runs
(https://github.com/anthropics/claude-code/issues/72162 comment); a fresh
session is the reliable check. `marketplace update` alone does **not** update
an installed plugin (same issue).

## Answers at a glance

1. **Update detection**: version string, resolved as plugin.json version →
   marketplace entry version → git commit SHA → `unknown`. Unchanged version ⇒
   update skipped ("already at the latest version"). https://code.claude.com/docs/en/plugins-reference
2. **Commands**: `/plugin marketplace update` refreshes the catalog;
   `claude plugin update <p>@<m>` updates the plugin. Third-party marketplaces
   have auto-update **off by default**; enable via `/plugin` UI or
   `"autoUpdate": true` on `extraKnownMarketplaces`. https://code.claude.com/docs/en/discover-plugins
3. **Local marketplace**: entries may use relative local paths; when the
   marketplace is added by local path the files are read live (edits take
   effect at next start or `/reload-plugins`, no version change), while
   installs from a hosted marketplace are copied into the cache.
   `claude --plugin-dir <dir>` loads a plugin directory directly, no cache.
   https://code.claude.com/docs/en/plugin-marketplaces
4. **Practice**: local marketplace / `--plugin-dir` for your own machine;
   for GitHub installs either omit `version` (commit-per-version) or bump it
   on every release. https://code.claude.com/docs/en/plugin-marketplaces
5. **Reload**: yes — `/reload-plugins` or a session restart is required after
   an update; the running session keeps the versions it loaded at launch.
   https://code.claude.com/docs/en/discover-plugins

## Recommendation for this repository

Remove the `"version": "0.1.0"` field from `.claude-plugin/plugin.json` (and
keep the marketplace entry without a version) so that the git commit SHA
becomes the version and every pushed commit is treated as a new version — this
matches the docs' recommendation for actively developed plugins. Alternatively,
if stable version numbers are preferred, bump the field on every release; the
current combination of a fixed version and 67 unversioned commits is exactly
the documented no-update failure mode. Push the 20 unpushed commits, since no
mechanism can deliver commits that do not exist on GitHub. On the development
machine, add the marketplace by local path (or use `claude --plugin-dir .`) to
get live loading without any cache. On machines that already have the stale
copy: enable marketplace auto-update, run `/plugin marketplace update
opencode-subagents` and `claude plugin update
opencode-subagents@opencode-subagents`, then `/reload-plugins` (or reinstall
the plugin once if the cache is inconsistent).

## Search log

- `websearch`: "Claude Code plugin update version detection" — 3 highly
  relevant hits (official docs, plugins-reference mirror, GitHub issues).
- `websearch`: "Claude Code plugin marketplace auto-update" — 5 relevant hits
  (plugin-marketplaces docs, discover-plugins, several update bugs).
- `task` (reader) on code.claude.com plugin-marketplaces / plugins-reference —
  exact quotes for local-path sources, `--plugin-dir`, version resolution.

## Open questions

- Whether an absolute local path *outside* the marketplace directory is
  supported as a plugin `source` (docs only confirm relative paths; not
  verified).
- Exact current behaviour of auto-update for third-party git marketplaces
  across recent versions: multiple bugs (#60772, #83777) report the background
  refresh not pulling; at least #83777 was reported fixed on recent releases.
  Unverified on the version installed on the user's machines.
- Whether the situation's exact cache path
  (`cache/opencode-subagents/opencode-subagents/0.1.0/`) reflects
  `marketplace-name/plugin-name` (assumed from docs and issue reports, not
  verified on disk here).
