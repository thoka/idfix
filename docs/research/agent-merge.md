# Do same-name opencode agents merge or replace?

Step 3a of the shared agents plan. Tested with opencode 1.18.32. The scratch
folders lived in `.opencode/context/agent-merge/` of this worktree (git
ignored): `P/` is the fake plugin dir (`agents/coder.md`), `D/` is the fake
project (`git init`, `.opencode/agents/coder.md`, `opencode.json` with the
same provider block and `{file:...}` key reference as the real worktree).
Every file had distinct markers: `PLUGIN-*` / `PROJECT-*` description, prompt
body, and the bash rules `"echo plugin-*": deny` (P) and `"echo project-*":
deny` (project). Free `opencode debug agent coder` showed the resolved
description, prompt, model, and the full bash rule list, so no paid run was
needed.

## Result table

| Case | Files and variables | Resolved description | Resolved prompt | Resolved bash rules (in printed order) | Conclusion |
|---|---|---|---|---|---|
| 1 | P `agents/coder.md` (full) + D `.opencode/agents/coder.md` (full) | `PLUGIN-CODER-DESCRIPTION` | `PLUGIN-PROMPT-BODY` | `*`=allow, `echo project-*`=deny, `echo plugin-*`=deny | Field-level merge. Plugin file wins conflicting fields; project-only bash keys survive and are effective. |
| 2a | P full + D project file with only `permission` (no `*` key) | PLUGIN | PLUGIN | `echo project-*`=deny, `*`=allow, `echo plugin-*`=deny | Plugin prompt and model stay. But the project deny key lands BEFORE the plugin `*`=allow, and matching takes the LAST match, so the project deny is inert. |
| 2b | P full + project file with `*`: allow first, then project rules | PLUGIN | PLUGIN | `*`=allow, `echo project-*`=deny, `bun test*`=allow, `echo plugin-*`=deny | The workable host-mode pattern: project rules land after `*` and win; the plugin's own deny rules stay last and cannot be re-allowed. |
| 3b | P full + `agent.coder.permission.bash` map in D `opencode.json` | PLUGIN (a JSON description did NOT win) | PLUGIN | `echo json-*`=deny, `*`=allow, `echo plugin-*`=deny | JSON agent config merges per field with the file agents, but its bash keys land FIRST, before the plugin `*`=allow, so they are inert. |
| 3c | Same map via `OPENCODE_CONFIG_CONTENT` | PLUGIN | PLUGIN | content keys land LAST, after the plugin rules | CONTENT merges after everything, so its map keys are appended last and WIN. |
| 4 | `OPENCODE_CONFIG_CONTENT` = `{"agent":{"coder":{"permission":{"bash":"allow"}}}}` (what `sandboxConfigContent` sets) on top of cases 1/2/3 | PLUGIN | PLUGIN | single rule `*`=allow | The string value replaces the whole merged bash map: project rules AND plugin deny rules are wiped. |

## Answers

1. **Merge, not replace — field by field.** All agent files with the same name
   are deep-merged into one `cfg.agent.coder` object; for each field the later
   source wins (`item.prompt = value.prompt ?? item.prompt`, `item.description
   = value.description ?? item.description`, and the `permission` maps merge
   key by key). A project file with only a `permission` block keeps the plugin
   prompt, description, and model. Only the bash *map keys* merge; there is no
   whole-file replacement.
2. **`OPENCODE_CONFIG_DIR/agents/` has the higher precedence.** Config
   directories are processed in the order global config, project
   `.opencode/...` walking up, home `.opencode`, then `OPENCODE_CONFIG_DIR`
   last, and each directory's agent files are merged over the accumulated
   result with `mergeDeep`, so the plugin agent wins every field that it
   defines. The project file wins only fields that the plugin file omits.
3. **(a) Yes, with one condition.** A project `.opencode/agents/coder.md` with
   only a `permission` block keeps the base prompt and model, and the project
   bash rules apply — but only if the project bash map repeats `"*": "allow"`
   (or every key the plugin defines) *before* its own rules. Without that, the
   plugin's `*: allow` appends after the project keys and, because matching
   takes the last matching rule, the project deny is silently shadowed.
   (b) No. `agent.coder.permission.bash` in the project `opencode.json` merges
   but its keys land before the plugin file rules, so the plugin `*: allow`
   shadows them. (c) Yes, and fully: `OPENCODE_CONFIG_CONTENT` merges last, so
   its bash keys are appended after the plugin rules and win. In all three the
   base prompt of the plugin coder stays.
4. **The sandbox string `"bash": "allow"` replaces the whole merged bash
   map** with a single `*: allow` rule. On top of every case, the project
   rules and the plugin's deny rules are gone. The prompt, description, and
   model survive. So in sandbox mode today, no project bash rule can apply.

## Why (source, opencode v1.18.32)

- Directory order, `OPENCODE_CONFIG_DIR` last:
  [`packages/opencode/src/config/paths.ts`](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/config/paths.ts)
  (`directories` returns `[Global.Path.config, ...project .opencode walk,
  ...home .opencode walk, ...(Flag.OPENCODE_CONFIG_DIR ? [...] : [])]`).
- Per-directory agent merge with `mergeDeep` (later directory wins), and
  `OPENCODE_CONFIG_CONTENT` merged after the whole directory loop:
  [`packages/opencode/src/config/config.ts`](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/config/config.ts)
  (in the `for (const dir of directories)` loop: `result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.load(dir)))`; afterwards `if (process.env.OPENCODE_CONFIG_CONTENT) { ... yield* merge(source, next, "local") }`).
- Agent files become one object per name:
  [`packages/opencode/src/config/agent.ts`](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/config/agent.ts)
  (`{ name, ...md.data, prompt: md.content.trim() }`).
- Per-field override and permission list merge in the Agent service:
  [`packages/opencode/src/agent/agent.ts`](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/agent/agent.ts)
  (`item.prompt = value.prompt ?? item.prompt`, `item.description = value.description ?? item.description`, `item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))`).
- Last matching rule wins:
  [`packages/opencode/src/permission/index.ts`](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/permission/index.ts)
  (`evaluate` uses `rulesets.flat().findLast((rule) => Wildcard.match(...))`).

## Recommendation

In **host mode**, a project should add its test allowlist through a project
`.opencode/agents/coder.md` that contains only a `permission` block whose
`bash` map starts with `"*": "allow"` and then lists the project rules (for
example `"bun test*": "allow"`, `"*.env*": "deny"`). That keeps the plugin
prompt, description, and model without a copy, and the plugin's own deny rules
still win because they merge in last. The plain `opencode.json` route is
inert and should be documented as not working. Alternatively — and the more
robust design for `src/up.ts` — the plugin could merge the project's bash
rules into its `OPENCODE_CONFIG_CONTENT` (object form), because content keys
always land last.

In **sandbox mode**, `sandboxConfigContent` today sends the string
`"bash": "allow"`, which wipes every project and plugin bash rule. If the
sandbox should honor a project allowlist, it must stop sending the blanket
string: either drop it entirely (the `sbx` container already bounds the blast
radius) or merge only specific allow keys in object form. Note that with
`findLast` matching, appending `{"*": "allow"}` in object form would also wipe
the file denies — the blanket allow must not be appended last. This changes
the assumption in the current comment of `src/sandbox.ts` (which says a whole
rule object replaces and an object value would lose to the file rules; with
`findLast` the last-merged object keys actually win).

## Cost

Paid runs: 0. Cost: 0.00 USD. Everything came from `opencode debug agent`.
