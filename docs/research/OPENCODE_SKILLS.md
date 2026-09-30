# How opencode finds skills, and how a sandbox can see global skills

Research date: 2026-09-30. For opencode 1.18.32 (see `mise.toml`), source checked at `anomalyco/opencode` HEAD `2fa3363` (dev branch). Facts carry a source (URL or file with line number); claims without one are marked **[guess]**.

## 1. Which folders does opencode search for skills?

Global (from the user home):

- `~/.config/opencode/skill/` and `~/.config/opencode/skills/` (pattern `{skill,skills}/**/SKILL.md`)
- `~/.claude/skills/` (`skills/**/SKILL.md`)
- `~/.agents/skills/` (`skills/**/SKILL.md`)

Project: for each of `.claude`, `.agents`, and `.opencode`, opencode walks up from the current working directory to the git worktree and scans every matching folder found along the way.

Docs: https://opencode.ai/docs/skills/ — "OpenCode searches these locations: Project config: `.opencode/skills/*/SKILL.md` ... Global config: `~/.config/opencode/skills/*/SKILL.md` ... Project Claude-compatible: `.claude/skills/*/SKILL.md` ... Global agent-compatible: `~/.agents/skills/*/SKILL.md`" and "For project-local paths, OpenCode walks up from your current working directory until it reaches the git worktree."

Source: `packages/opencode/src/skill/index.ts`, `discoverSkills` — https://github.com/sst/opencode/blob/47f33329/packages/opencode/src/skill/index.ts:

```ts
const CLAUDE_EXTERNAL_DIR = ".claude"
const AGENTS_EXTERNAL_DIR = ".agents"
const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
...
const root = path.join(global.home, dir)          // global ~/.claude, ~/.agents
...
const upDirs = yield* fsys.up({ targets: externalDirs, start: directory, stop: worktree })
...
for (const dir of configDirs) {
  yield* scan(state, dir, OPENCODE_SKILL_PATTERN) // configDirs = Config.directories()
}
```

And `Config.directories()` includes the custom directory: `packages/opencode/src/config/paths.ts` (raw source, dev branch, checked 2026-09-30):

```ts
return unique([
  Global.Path.config,
  ...(yield* afs.up({ targets: [".opencode"], start: directory, stop: worktree })),
  ...(yield* afs.up({ targets: [".opencode"], start: Global.Path.home, stop: Global.Path.home })),
  ...(Flag.OPENCODE_CONFIG_DIR ? [Flag.OPENCODE_CONFIG_DIR] : []),
])
```

So yes — `<OPENCODE_CONFIG_DIR>/skill/` and `<OPENCODE_CONFIG_DIR>/skills/` are also scanned, and `OPENCODE_CONFIG_DIR` comes last in the list, so it overrides project folders. The docs only promise agents/commands/modes/plugins for the custom directory (https://opencode.ai/docs/config/#custom-directory: "This directory will be searched for agents, commands, modes, and plugins just like the standard `.opencode` directory"), but the code confirms skills too (paths.ts above plus the `scan(state, dir, OPENCODE_SKILL_PATTERN)` loop in skill/index.ts).

External scans can be turned off with `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` and `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1` (https://github.com/anomalyco/opencode/blob/dev/packages/core/src/plugin/skill/customize-opencode.md, and the flags in skill/index.ts).

Precedence (later wins): built-in skills → `.claude/skills` (global, then farthest ancestor → cwd) → `.agents/skills` (same) → `~/.config/opencode/skills` → project `.opencode/skills` (root → cwd) → explicit `skills` config entries (https://opencode.ai/v2/docs/skills, "Sources are registered from lower to higher precedence"; the v2 page is the same feature documented for the next major).

## 2. Configuration key for extra skill folders

Yes. `skills.paths` (and `skills.urls` for HTTP catalogs) in any `opencode.json` / `opencode.jsonc`; arrays from every config file are combined, not replaced:

```jsonc
{ "skills": ["./team-skills", "~/shared/opencode-skills", "/opt/company-skills"] }
```

https://opencode.ai/v2/docs/skills: "Add more local directories or HTTP catalogs with the `skills` array in any `opencode.json` or `opencode.jsonc`". The v1 code reads `cfg.skills?.paths` (and `skills.urls`); paths starting with `~/` resolve against the home of the process, absolute paths are used as written, relative ones resolve against the current working directory — skill/index.ts:

```ts
for (const item of cfg.skills?.paths ?? []) {
  const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
  const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
```

The older source used the object form `skills: { paths: [...], urls: [...] }` (https://github.com/anomalyco/opencode/blob/dev/packages/core/src/plugin/skill/customize-opencode.md). The array form in the v2 docs may be a v2 change **[guess — verify before relying on the array form; the object form `skills.paths` works in 1.18.32 per the 1.x source]**.

## 3. Does opencode follow a symlinked skill folder?

Yes, at scan time. Every `Glob.scan` call in the skill loader sets `symlink: true` — skill/index.ts line ~154, and the same in the older `packages/opencode/src/skill/skill.ts` (https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/skill/skill.ts: `Glob.scan(EXTERNAL_SKILL_PATTERN, { cwd: root, absolute: true, include: "file", dot: true, symlink: true })`). So a symlinked `~/.agents/skills/<name>` (or a whole symlinked `skills` directory) is followed and its `SKILL.md` files are loaded. **[Verified in code, not by a runtime test against a mounted sandbox.]**

## 4. Skill format and loading

Same format as Claude Code: one folder per skill with a `SKILL.md` in YAML frontmatter. https://opencode.ai/docs/skills/: "Each `SKILL.md` must start with YAML frontmatter. Only these fields are recognized: `name` (required), `description` (required), `license` (optional), `compatibility` (optional), `metadata` (optional, string-to-string map). Unknown frontmatter fields are ignored." Name rules: 1–64 chars, `^[a-z0-9]+(-[a-z0-9]+)*$`, "Match the directory name that contains `SKILL.md`"; description "must be 1-1024 characters".

In the code, frontmatter is validated with `Skill.Info.pick({ name: true, description: true })` and a skill whose parse fails is silently dropped (`if (!parsed.success) return`, skill/skill.ts above). So a missing `name` or `description` means the skill is silently missing — no hard error. Extra unknown fields are ignored, not rejected.

Loading: a native `skill` tool. "Skills are loaded on-demand via the native `skill` tool—agents see available skills and can load the full content when needed" and "OpenCode lists available skills in the `skill` tool description ... The agent loads a skill by calling the tool: `skill({ name: "git-release" })`" (https://opencode.ai/docs/skills/). The tool list is filtered by agent permissions: skill/index.ts `available(agent)` filters with `Permission.evaluate("skill", skill.name, agent.permission).action !== "deny"`. Permissions are configured as `permission.skill` maps with `allow`/`deny`/`ask` and wildcards, per agent in agent frontmatter (`permission: skill: "documents-*": "allow"`) or for built-in agents in `opencode.json` (`agent.plan.permission.skill`); `tools: skill: false` disables the tool entirely (https://opencode.ai/docs/skills/, "Configure permissions").

## 5. `sbx create`: more mounts, different target paths?

`sbx` 0.45.1 accepts more than two read-only mounts: `oc-sub up` already creates sandboxes with three mounts — `sbx create --name NAME opencode ROOT ./opencode:ro ./mise-installs:ro` (src/sandbox.ts:484-490, test/sandbox.test.ts:523-524).

Mount targets: because `sbx` rejects an absolute path with `:ro`, the plugin mounts relative paths from working directory `/`, which makes the folder appear **under its host absolute path** inside the sandbox (src/sandbox.ts:480-485 comment; docs/research/SANDBOX.md:119). Whether `sbx create` can mount a host folder at a *different* guest path (a `HOST:GUEST` syntax or a flag) is not documented in SANDBOX.md and was not tested — **unverified, open**. Nothing found suggests a remap is possible; assume same-path-only until tested.

## Recommendation

Add a third read-only mount of `~/dv/meta/agents/skills` to `sbx create`, again as a relative path from working directory `/` so it appears under its host absolute path inside the sandbox (same trick as the plugin and mise mounts; extend `relativeMount` usage in src/sandbox.ts). Then, still during `sbx create`, run once via `sbx exec`: `mkdir -p /home/agent/.claude && ln -s <host-skills-path> /home/agent/.claude/skills` — the sandbox disk persists (SANDBOX.md:121), so the symlink survives restarts, and opencode then finds every global skill through its default `~/.claude/skills` scan, which follows symlinks. This needs no config change and no env var. (An alternative that avoids the symlink: set `skills: { paths: ["<host-skills-path>"] }` in the plugin's `opencode/opencode.json` — it is loaded through `OPENCODE_CONFIG_DIR` and combined with other skills arrays — but that bakes a host-specific absolute path into a committed file.)

## Open questions

- Does the `skills` config key in 1.18.32 accept the flat array form (v2 docs) or only the object form `{ paths, urls }` (1.x source)? Untested.
- Does `sbx create` support mounting at a guest path different from the host path? Untested.
- Runtime test that a symlinked global skills folder inside a sandbox is actually loaded (code says yes via `symlink: true`).
- Whether `skills/*/SKILL.md` in the external `.claude`/`.agents` scan follows a symlinked *skill folder* the same way it follows symlinked files in the glob — code suggests yes, untested.
