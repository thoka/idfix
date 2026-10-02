---
checked: 2026-10-02
recheck: 1m
decisions:
  - "keep the split: Claude Code on the Claude subscription, opencode subagents on OpenRouter"
---

# Claude Max vs OpenRouter for our way of working

Date: 2026-10-02. Research only, no code changes. No paid API call was made and no key file was read.

Our way of working: one developer runs several projects with Claude Code as the main agent. Cheap subagents (opencode with GLM 5.3 Flash) run through OpenRouter, one key per project, real cost logged per run (README.md, docs/research/real-cost.md, docs/research/subagent-model.md). Typical runs cost $0.03 to $0.10.

## Criteria

- Compliance: what the Anthropic terms and docs allow for each auth method.
- Cost per unit of work: dollars per run or per million tokens.
- Volume: how much work a plan or a budget covers before limits hit.
- Quality: benchmark evidence for coding-agent work, vendor-run vs independent.
- Accounting: can we keep logging real cost per run?
- Risk: what breaks, and what we lose if a provider changes rules.

## 1. Claude plans today

From https://claude.com/pricing/ (read 2026-10-02) and https://support.claude.com/en/articles/11049741-what-is-the-max-plan (read 2026-10-02):

| Plan | Price | Includes | Claude Code |
| --- | --- | --- | --- |
| Free | $0 | chat only | No |
| Pro | $20/mo ($17/mo billed annually at $200 up front) | Claude Code, Research, Projects, Design, Slides, Docs, "more Claude models" | Yes |
| Max 5x | $100/mo | Everything in Pro, "5x more usage than Pro", higher output limits, early access, priority at peak | Yes |
| Max 20x | $200/mo | Everything in Pro, "20x more usage than Pro", same extras | Yes |

Models on the plans (pricing page table, read 2026-10-02): Sonnet and Haiku on all paid plans; Opus on Pro/Max; Fable only via usage credits on Pro and "50% of weekly limits" on Max. The pricing page names the current models "Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 4.5". Pro and Max include Research; Free does not.

Limit mechanics (pricing FAQ and Max article, read 2026-10-02):

- "Every plan has usage limits that reset on a rolling five-hour session window, and paid plans add weekly limits on top."
- "Your activity across Claude on web, desktop, mobile, and Claude Code all draws from the same pool."
- The multiplier is per 5-hour session, not per week: "Max gives you 5x or 20x more usage per 5-hour session than Pro."
- "The weekly limit resets at a fixed time each week that is assigned to your account."
- Anthropic publishes no token or message numbers. "we may limit your usage in other ways, such as weekly and monthly caps or model and feature usage, at our discretion."
- Over the limit: "When you reach a limit, you can wait for it to reset, move to a higher plan, or, on paid plans, turn on usage credits to keep working at standard API rates." So the overage path is usage credits billed at API rates, switched on by the user with a cap.
- Secondary sources report Anthropic doubled the 5-hour Claude Code limits on 2026-05-06 and removed peak-hour reductions (deployhyre.com/ai-tools/claude-usage-limits, dated 2026-06-27 — search excerpt, not read through the reader). [guess] Treat the exact size of a 5-hour or weekly allowance as unknown; Anthropic does not publish it, and community numbers are estimates.

A filed class action alleges Max delivers far less than the label (roughly 6x Pro rather than 20x; christopheralarcon.com/blog/claude-max-5x-vs-20x, 2026-08-14 — search excerpt, not read through the reader). [guess] Directionally consistent with Anthropic's own wording, which promises the multiplier per session only.

## 2. Rules on subscription use

From https://code.claude.com/docs/en/legal-and-compliance (read 2026-10-02):

- "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
- "Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users."
- "Using OAuth tokens obtained through Claude Free, Pro, or Max accounts in any other product, tool, or service — including the Agent SDK — is not permitted and constitutes a violation of the Consumer Terms of Service." (quoted by theregister.com, 2026-02-20, read 2026-10-02, as the February 2026 clarification.)
- "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."
- "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."

The Consumer Terms forbid automated access without an API key or explicit permission: "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, [you may not] access the Services through automated or non-human means, whether through a bot, script, or otherwise." (Consumer Terms via archive.ph — search excerpt, not read through the reader; theregister.com confirms this clause has stood since at least February 2024.)

What this means for each of our paths:

- Claude Code background sessions and headless `claude -p`: allowed in principle — this is Claude Code itself, and the limits "assume ordinary, individual usage of Claude Code and the Agent SDK". But "ordinary, individual usage" is undefined; heavy parallel headless orchestration may deviate from it. [guess]
- Agent SDK driven by a subscription: not permitted (quote above).
- Third-party tools such as opencode with subscription OAuth: not permitted.

Enforcement in 2026 (venturebeat.com, 2026-01-09, and theregister.com, 2026-02-20, both read 2026-10-02):

- January 2026: Anthropic deployed technical safeguards against tools that spoof the Claude Code client. "some user accounts were automatically banned for triggering abuse filters—an error the company is currently reversing." Claude Code engineer Thariq Shihipar: "Third-party harnesses using Claude subscriptions create problems for users and are prohibited by our Terms of Service."
- 2026-02-20: Anthropic clarified the legal page (quote above).
- 2026-02-19: "OpenCode pushed code to remove support for Claude Pro and Max account keys and Claude API keys. The commit cites 'anthropic legal requests.'" So opencode itself removed subscription auth upstream; only third-party community plugins still offer it (github.com/shuv1337/opencode-anthropic-oauth — search excerpt, not read through the reader), which puts the ToS risk entirely on the user.
- Anthropic's transparency hub reports 11.4 million banned accounts in January–June 2026 across all reasons (anthropic.com/transparency/system-trust-reporting — search excerpt, not read through the reader).
- GitHub issues show false-positive bans of paying Max subscribers who used only official Claude Code (anthropics/claude-code issues #51670, #51583, #68658 — search excerpts, not read through the reader). Risk of automated bans exists even for compliant use.

Conclusion: a Claude Max subscription can legally drive Claude Code only — interactive, background, or headless. It cannot drive opencode, oc-sub, or any other harness, and the API key path (not subscription) is the only legal programmatic path outside Claude Code.

## 3. Claude API prices

From https://claude.com/pricing/ "Latest models" section (read 2026-10-02; docs.anthropic.com URL 404'd):

| Model | Input $/MTok | Output $/MTok | Cache write (5m) $/MTok | Cache read $/MTok |
| --- | --- | --- | --- | --- |
| Opus 5.5 | $4 | $20 | $5 | $0.20 |
| Sonnet 5.5 | $2 | $10 | $2.50 | $0.20 |
| Haiku 4.5 | $1 | $5 | $1.25 | $0.10 |

Notes from the same page: batch saves 50%; fast mode for Opus 5.5 at 2x. Legacy Opus 5 / Opus 4.8: $5/$25, cache read $0.50 (same page). Anthropic list prices match OpenRouter for the current models: OpenRouter shows `anthropic/claude-opus-5.5` $4/$20 and `anthropic/claude-sonnet-5.5` $2/$10, cache read $0.20 (curl of https://openrouter.ai/api/v1/models, 2026-10-02). OpenRouter adds no markup on Anthropic list prices but its cache-write and batch variants differ slightly.

## 4. Open prices on OpenRouter

From curl https://openrouter.ai/api/v1/models (2026-10-02), prices per MTok in/out/cache-read:

| Model | In | Out | Cache read |
| --- | --- | --- | --- |
| z-ai/glm-5.3-flash | $0.15 | $0.50 | $0.03 |
| z-ai/glm-5.3 | $1.40 | $4.40 | $0.14 |
| z-ai/glm-5.2 | $0.41 | $3.99 | $0.26 |
| z-ai/glm-5 | $0.60 | $1.92 | $0.12 |
| deepseek/deepseek-v3.2 | $0.28 | $0.42 | $0.028 |
| deepseek/deepseek-chat-v3.1 | $0.25 | $0.95 | $0.13 |
| qwen/qwen3-coder-plus | $0.65 | $3.25 | $0.13 |
| qwen/qwen3-235b-a22b-2507 | $0.09 | $0.35 | $0.02 |
| moonshotai/kimi-k2.6 | $0.43 | $1.83 | $0.073 |
| moonshotai/kimi-k3 | $2.70 | $13.50 | $0.27 |
| anthropic/claude-sonnet-5.5 | $2 | $10 | $0.20 |
| anthropic/claude-opus-5.5 | $4 | $20 | $0.20 |

GLM-5.3-Flash remains roughly 13x cheaper than Sonnet 5.5 on input and 20x on output.

## 5. Quality: coding-agent benchmarks

Vendor-run vs independent, with who ran it and when:

- GLM-5.3 (the family our Flash model comes from), independent runs: Terminal-Bench 2.1 at 83.9 by Artificial Analysis (2026-08-19, inside the benchmark's ±10.6 noise band; Z.ai's self-report was 88.2); DeepSWE 69.0 by deepswe.datacurve.ai (2026-08-26, 2.1 points above Z.ai's own 66.9); SWE-bench Verified 95.4 by vals.ai (2026-08-19, but graded saturated) (themodelgap.com/models/glm-5-3, read 2026-10-02).
- Claude Opus 4.8: SWE-bench Verified 88.6, SWE-bench Pro 69.2 (model card, per jessemoraga.com, 2026-07-25 — search excerpt, not read through the reader); Terminal-Bench 2.1 85.0 (Z.ai launch table per glm5.app, 2026-08-27 — search excerpt, not read).
- GLM-5.3-Flash (the model we actually run): Z.ai reports 84.3 Terminal-Bench 2.1, 63.4 DeepSWE v1.1, "approaching Claude Opus 4.8" (z.ai/blog/glm-5.3-flash, 2026-08-26 — the page did not render for the reader; numbers via glm5.app and benchlm.ai excerpts, not read directly). No independent Terminal-Bench run for Flash itself was found. [guess] Its real quality is likely somewhat below its vendor numbers, as the vendor-high pattern is common.
- Claude Opus 5: SWE-bench Verified 96.0 (mean of five trials, system card §8.2), Frontier-Bench v0.1 43.3 (per jessemoraga.com, 2026-07-25 — search excerpt). Terminal-Bench 4.0 (harder, not comparable to 2.1): Fable 5.1 57.9, Opus 5 51.8, GLM-5.3 41.8 (official tbench.ai runs, per codingfleet.com, updated 2026-09-25 — search excerpt, not read).
- Independent aggregate: Artificial Analysis Intelligence Index 57 for GLM-5.3-Flash, vs GLM-5.3 trailing Claude Opus 5/5.5 by 4–19 points on reasoning benchmarks (themodelgap.com, read 2026-10-02).

Summary: GLM-5.3-Flash is at or near Opus 4.8 on some vendor-selected agentic benchmarks, but independent evidence is thin for Flash specifically, and the newest Anthropic models (Opus 5.5, Fable 5.1) clearly lead on the harder Terminal-Bench 4.0. For small, well-scoped subagent steps, the gap that matters is smaller than for full-agent work. [guess]

## 6. Measuring the API-equivalent value of a subscription

The standard tool is `ccusage` (https://github.com/ccusage/ccusage, read 2026-10-02). It reads the local JSONL logs that Claude Code already writes (default `~/.config/claude/projects/` or legacy `~/.claude/projects/`) and estimates the cost at API prices from token counts and a pricing table (LiteLLM). Run it without install:

```
bunx ccusage          # or: npx ccusage@latest
bunx ccusage daily    # all detected sources by day
bunx ccusage blocks   # Claude Code 5-hour billing windows
bunx ccusage monthly --mode calculate --breakdown   # token-based API-equivalent estimate
```

Cost modes: `auto` (default), `calculate` (always recompute from tokens — this is the API-equivalent number), `display` (only Claude's own pre-calculated costUSD). Costs are estimates; `--offline` uses pre-cached pricing. It also covers opencode logs (`ccusage opencode daily`), so one tool reports both sides of our split.

## 7. Break-even arithmetic

All numbers are list prices; a run's token mix is an assumption, marked [guess].

Assumed typical subagent run [guess]: 0.5M input tokens (mostly cache reads) and 30k output. This matches our observed $0.03–$0.10 per GLM-Flash run.

- GLM-5.3-Flash per run: 0.5M × $0.15 + 0.03M × $0.50 ≈ $0.09. Matches the logged $0.03–$0.10.
- Sonnet 5.5 per run: 0.5M × $0.20 (cache read) + 0.03M × $10 ≈ $0.40.
- Opus 5.5 per run: 0.5M × $0.20 + 0.03M × $20 ≈ $0.70.

Break-even for the subscriptions, measured in API-equivalent dollars (the number ccusage reports):

- Max 5x ($100/mo) pays off when API-equivalent usage exceeds $100/mo — about 250 Sonnet-like runs or 140 Opus-like runs of the assumed size per month.
- Max 20x ($200/mo) pays off above $200/mo — about 500 Sonnet-like or 285 Opus-like runs per month.
- Pro ($20/mo) pays off above $20/mo of API-equivalent usage — about 50 Sonnet-like runs per month. This is the cheapest entry point and the right first step, because Max buys only headroom, not features.

Versus OpenRouter GLM-5.3-Flash: one Max 5x month ($100) buys about 1,100 GLM-Flash runs of the assumed size ($0.09 each). Our current total subagent volume is far below that [guess — actual spend pending], so moving subagent work into a Max subscription cannot pay off on cost. It could pay off only in quality (Sonnet/Opus instead of Flash) at much lower volume, but only through Claude Code itself, never through opencode (see section 2).

## Our OpenRouter spend

Measured on 2026-10-02 by the main thread with `bunx ccusage@latest monthly --mode calculate --offline` (ccusage reads the local Claude Code, Codex, and opencode logs and prices the tokens at API list prices):

| Month | Claude Code (API-equivalent) | opencode on the host (API-equivalent) |
| --- | --- | --- |
| 2026-08 | none in the logs | $0.03 |
| 2026-09 | $803.52 | $30.52 |
| 2026-10 (two days) | $50.18 | none on the host |

Two limits of these numbers:
- The opencode column covers only the opencode logs on the host. Runs in a Docker sandbox write their logs inside the sandbox, so ccusage misses them. The real OpenRouter spend per project comes from the key usage at OpenRouter (`GET /api/v1/key`, fields `usage` and `usage_monthly`). The user reads it, because agents do not read key files.
- The opencode column is a list-price estimate, not the real charge. The real charge of the runs on 2026-10-02 was $0.03 to $0.08 per run (cost proxy).

So the Claude Code use in September is worth about $800 at API prices. That is four times the price of Max 20x and eight times the price of Max 5x. The subagent spend on OpenRouter is one or two orders of magnitude smaller.

## Options

### (a) Keep the current split (Claude Code on a Claude subscription, subagents on OpenRouter)

- Gains: fully compliant (each tool uses its intended auth); real cost logged per run through the OpenRouter key (docs/research/real-cost.md); quality where it matters (main agent on Claude models) and cost where volume matters (Flash subagents); no single point of ban risk for the coding pipeline.
- Costs: two bills; subagent quality capped at Flash-class.
- Risks: OpenRouter price or routing changes (tracked in provider-probe.md); Anthropic ban risk exists even for compliant Claude Code use (section 2, GitHub issues).

### (b) Move subagent work into the Claude subscription

- Only legal route: drive `claude -p` / background Claude Code sessions instead of opencode. This replaces oc-sub's harness, sandbox, and cost accounting, and hits "ordinary, individual usage" limits fast with parallel runs. opencode with subscription OAuth is prohibited and opencode upstream removed it.
- Gains: Sonnet/Opus quality in subagents at flat rate; one bill.
- Costs: loses per-run real-cost logging (no OpenRouter charge); loses the opencode sandbox and agent config; needs a rewrite of oc-sub around claude -p, which has known automation problems (empty responses, no quota API — yage.ai analysis, search excerpt, not read). $100/mo minimum vs well under that in actual OpenRouter spend.
- Risks: ToS gray zone for orchestrated headless volume; account bans are automated and opaque (2026 GitHub issues); no way to attribute cost per project.

### (c) Move to API only (no subscription)

- Gains: everything metered and logged; no "ordinary usage" ambiguity; Agent SDK becomes legal; pay-per-use for occasional months.
- Costs: at API-equivalent usage above $20–$100/mo, Pro or Max is cheaper (section 7); lose the flat-rate headroom for the main agent.
- Risks: cost spikes in heavy months; still needs Anthropic API key handling per project.

## Recommendation

Keep option (a), the current split. The criteria that decide it: compliance (the subscription legally drives only Claude Code, and opencode removed subscription auth after Anthropic's legal request), cost (our GLM-Flash subagent volume is orders of magnitude below what any Max plan pays off), accounting (the OpenRouter key logs real cost per run, which a subscription cannot), and risk (option (b) concentrates automated-ban risk on the account we also use for the main agent). First step under (a): start Pro ($20/mo) if not already subscribed, measure API-equivalent usage with `bunx ccusage monthly --mode calculate`, and only consider Max when that number crosses $100 for a full month.

## What I could not find out

- Any published token, message, or hour quota for Pro/Max windows — Anthropic publishes none; community numbers are estimates.
- GLM-5.3-Flash benchmark scores that are independent of Z.ai (the z.ai blog did not render through the reader; Flash figures came via secondary pages not read through the reader).
- The exact current text of the Consumer Terms section 3.7 (read via archive.ph excerpt and The Register's quote, not the live page).
- The user's actual OpenRouter spend per project — left as a placeholder table.
