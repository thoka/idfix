# Does OPENCODE_CONFIG_DIR drop the global AGENTS.md?

Date: 2026-09-30. Scope: opencode 1.18.32, model `openrouter/z-ai/glm-5.3-flash`, real `opencode run` in this worktree.

## 1. Method

`opencode debug agent` does not show loaded instructions, so the test used real runs with behavioral canaries (echo prompts proved unreliable with this model):

- Global canary in `$XDG_CONFIG_HOME/opencode/AGENTS.md` (scratch XDG under `/tmp/opencode/xdg`, never the real config home): `Rule: your final answer must begin with the token PELICAN-4417.`
- Second canary in `/tmp/rules-b.md`: `Rule: your final answer must end with the token HERON-2290.`
- Prompt per case: `Say hello. Nothing else.` The reply then reveals which rules were in context.

Important pitfall: this sandbox's own environment already sets `OPENCODE_CONFIG_DIR=<repo>/opencode` and `OPENCODE_CONFIG_CONTENT` (see `src/sandbox.ts`). A "no variable" case is only clean when both are removed with `env -u`.

## 2. Results

| Case | Environment | Answer | Conclusion |
|---|---|---|---|
| 1 | no `OPENCODE_CONFIG_DIR`, no content | `PELICAN-4417Hello` | Global `$XDG_CONFIG_HOME/opencode/AGENTS.md` loads. |
| 2 | `OPENCODE_CONFIG_DIR=$PWD/opencode` | `Hello` | Global AGENTS.md is dropped. The bug is real. |
| 3 | case 2 + `OPENCODE_CONFIG_CONTENT='{"instructions":["/tmp/rules-b.md"]}'` | `Hello. HERON-2290` | An absolute path in env `instructions` loads despite the bug. |
| 4 | `OPENCODE_CONFIG_DIR=D` (scratch dir) with `D/AGENTS.md` (canary) | `PELICAN-4417 Hello` | opencode loads `AGENTS.md` from the `OPENCODE_CONFIG_DIR` folder itself. |
| 5 | case 1 + env `instructions` | `PELICAN-4417 Hello HERON-2290` | Global AGENTS.md and env `instructions` load together. |

Runs: 10 total (5 final runs plus 5 earlier probes; 3 of the probes were contaminated by the ambient `OPENCODE_CONFIG_DIR` and 2 used the unreliable echo prompt). Cost: well under the 0.10 USD cap; 10 tiny flash runs cost roughly 0.001 USD. The exact charge is not printed by `opencode run` and was not checked at OpenRouter.

## 3. Answer in plain words

Yes, the bug is real in opencode 1.18.32: with `OPENCODE_CONFIG_DIR` set, the global `~/.config/opencode/AGENTS.md` (more precisely the XDG config dir) is silently dropped, while `AGENTS.md` inside the override directory itself is loaded. This matches issue [28658](https://github.com/anomalyco/opencode/issues/28658): `instruction.ts` builds the global instructions path from the overridden `global.config` instead of the static XDG path. Issue [32825](https://github.com/anomalyco/opencode/issues/32825) reports the same root cause for v2/core services. As of today both issues are still open (28658 has open PR #47468), so no fixed version has shipped; 1.18.32 is affected.

Documented way to load a global rules file while `OPENCODE_CONFIG_DIR` points at the plugin folder: put the rules path into `instructions` (config field, or via `OPENCODE_CONFIG_CONTENT`, which sandbox mode already sets in `src/sandbox.ts`). Absolute paths work, and they combine with every AGENTS.md that does load (case 3 and 5). Alternatively, copy or mount `AGENTS.md` into the `OPENCODE_CONFIG_DIR` folder itself (case 4).

The opencode docs (opencode.ai/docs/rules, "Custom Instructions") say:

> You can specify custom instruction files in your `opencode.json` or the global `~/.config/opencode/opencode.json`. This allows you and your team to reuse existing rules rather than having to duplicate them to AGENTS.md.
>
> `{ "$schema": "https://opencode.ai/config.json", "instructions": ["CONTRIBUTING.md", "docs/guidelines.md", ".cursor/rules/*.md"] }`
>
> All instruction files are combined with your `AGENTS.md` files.

The docs also promise a "Global" AGENTS.md at `~/.config/opencode/AGENTS.md` "applied across all opencode sessions" — exactly what the bug breaks when `OPENCODE_CONFIG_DIR` is set.

## 4. Consequence for oc-sub

`oc-sub up` (host `src/up.ts`, sandbox `src/sandbox.ts` around line 604) sets `OPENCODE_CONFIG_DIR`, so today every launched session silently loses the user's global rules. Sandbox mode can fix it without waiting for the upstream fix: extend the `OPENCODE_CONFIG_CONTENT` JSON it already builds with `"instructions": ["<path to the mounted global AGENTS.md>"]`. This update should also replace the claim in `.opencode/context/shared-agent-knowledge.md` (Question 1, Question 5, Review notes) with the tested result.
