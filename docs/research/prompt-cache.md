---
checked: 2026-10-02
recheck: 1m
decisions:
  - "whether the main thread keeps its session awake (ScheduleWakeup / keep-alive) while a subagent runs, and at what cadence"
  - "how oc-sub schedules follow-ups after long subagent waits (keep warm vs restart from plan files)"
---

# How long a Claude Code thread can wait before it pays for its context again

Date: 2026-10-02. Research only, no code changes. No paid API call was made.

The question: the main thread often waits 5–60 minutes for a subagent. The Anthropic prompt cache has a 5-minute default TTL, refreshed free on each use; 1-hour writes cost 2x input. Claude Code on a subscription requests the 1-hour TTL for the main conversation. Does it pay to keep the thread awake?

## Criteria

- Cash cost: API dollars per wait scenario.
- Quota cost: what each scenario takes from the 5-hour/weekly subscription limits.
- Effort: what we must build or configure.
- Risk: what breaks or silently invalidates the cache.
- Evidence: is the claim from Anthropic docs, or community measurement?

## Sources read through the reader

1. https://code.claude.com/docs/en/prompt-caching (2026-10-02)
2. https://platform.claude.com/docs/en/build-with-claude/prompt-caching (2026-10-02)
3. https://github.com/anthropics/claude-code/issues/75290 (2026-10-02)
4. https://github.com/anthropics/claude-code/issues/61522 (2026-10-02)

Everything else below is local output (`ccusage`, `gh`), prior reports in this repository (their pages were read through the reader on 2026-10-02), or marked [guess]. The websearch excerpts for ScheduleWakeup's tool text and the leaked system prompt were not read through the reader and are used only as leads; the clamp fact is cited from issue #61522, which was read.

## 1. Prompt cache rules today

From the API docs (platform.claude.com prompt-caching, read 2026-10-02):

- Two TTLs: 5-minute default, 1-hour opt-in via `cache_control: {"type": "ephemeral", "ttl": "1h"}`.
- "By default, the cache has a 5-minute lifetime. The cache is refreshed for no additional cost each time the cached content is used." So a read refreshes the TTL at the read price (0.1x; Opus 5.5 and Fable 5.1 are cheaper, see table).
- Multipliers: 5m write 1.25x base input, 1h write 2x, cache read 0.1x — except "Cache hits and refreshes on Claude Opus 5.5 are priced at 0.05x the base input price" ($0.20/MTok).
- Prices per MTok (base in / 5m write / 1h write / cache read):

| Model | Base in | 5m write | 1h write | Read |
| --- | --- | --- | --- | --- |
| Opus 5.5 | $4 | $5 | $8 | $0.20 (0.05x) |
| Sonnet 5.5 | $2 | $2.50 | $4 | $0.20 (0.1x) |
| Haiku 4.5 | $1 | $1.25 | $2 | $0.10 (0.1x) |

- Minimum cacheable prefix: "512 tokens for Claude Fable 5.1, Claude Mythos 5.1, Claude Opus 5.5, Claude Opus 5, Claude Sonnet 5.5, Claude Fable 5, and Claude Mythos 5" and "4,096 tokens for Claude Haiku 4.5".
- Breakpoints: "You can define up to 4 cache breakpoints" per request.
- The docs name our exact case: the 1-hour cache fits "when an agentic side-agent will take longer than 5 minutes" and "when storing a long chat conversation ... and you generally expect that user may not respond in the next 5 minutes".

## 2. What TTL Claude Code uses

From code.claude.com/docs/en/prompt-caching (read 2026-10-02). Two buckets: "Main conversation" (interactive turns, `-p` runs, SDK turns, inline helpers) and "Everything else" (subagents, workflows, forks, compaction, session titles).

- Subscription within included usage: main conversation gets **one hour**; "Everything else" gets five minutes, except a small set of server-controlled helper requests that get one hour.
- API key / Bedrock / Vertex / Foundry: five minutes everywhere.
- Overage: "Once you go over your plan's usage limit and Claude Code draws on usage credits, you are billed for that usage, so Claude Code drops the main conversation to the cheaper five-minute TTL. To keep the one-hour TTL there, choose the TTL yourself." This matches the system-instruction note in our session (drops to 5-minute TTL in usage overage).
- Overrides (both buckets, `5m` or `1h`, need Claude Code v2.1.242+): `promptCacheTtl` setting / `CLAUDE_CODE_PROMPT_CACHE_TTL` env var for the main conversation; `subagentPromptCacheTtl` / `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` for everything else; plus a `cacheTtl` value in a subagent's `experimental` frontmatter (v2.1.248+, and "Claude Code ignores a `1h` there while your Claude subscription is using usage credits").
- Precedence: `FORCE_PROMPT_CACHING_5M=1` > bucket env var > bucket setting > subagent frontmatter > `ENABLE_PROMPT_CACHING_1H=1` (one hour for both buckets) > bucket default.
- `ENABLE_PROMPT_CACHING_1H` is documented as "Intended for API key, Bedrock, Vertex, Foundry, and Claude Platform on AWS users. Subscription users within included usage receive 1-hour TTL automatically" (env-vars page, via GitHub issue #48082 verification, which I read in search results — the env-vars page itself truncated before those rows in the reader). `DISABLE_PROMPT_CACHING` and per-model `DISABLE_PROMPT_CACHING_{OPUS,SONNET,HAIKU,FABLE}` disable caching; Claude Code shows a startup warning when they are set (changelog v2.1.108, via issue #48090 search excerpt).
- History: ENABLE_PROMPT_CACHING_1H and FORCE_PROMPT_CACHING_5M were added in v2.1.108 (April 2026); GitHub issue #48082 documents the docs gap and its resolution. Issue #49139 reports the variable not working for API-key users until a backend fix; a commenter confirmed it started working. [fact from search excerpts of GitHub issues; not read via the reader]

## 3. Do cache reads and writes count against subscription limits?

What Anthropic says: essentially nothing specific. The pricing page says limits depend on "the length and complexity of your conversations, the model you choose, and the features you use" with "no fixed message count" (claude.com/pricing, quoted in the prior report claude-max-vs-openrouter.md). The API docs say cache hits "are not deducted against your rate limit" — that is the API rate limit, not the subscription allowance. I found no Anthropic page that says how cache read or write tokens are weighted against the Pro/Max 5-hour and weekly limits.

Community measurements (marked as such):

- GitHub issue #75290 (read 2026-10-02, closed as not planned, no maintainer response): a Max 5x user reports "70M cache read tokens counted against quota — $62/day on a $100/month plan", with local logs showing 70.23M cache reads vs 72.2K actual input tokens in one day, and the dashboard at "Session: 30% used (of 5-hour window); Weekly: 37% used". Their reading: "This suggests cached tokens are being counted at full weight against the subscription quota." Related issues (#41930, #38335, #65687, #69608) report abnormal quota drain episodes, one of which ("March 2026 caching bug") Anthropic acknowledged and fixed with account resets.
- [guess] The most consistent model: the subscription allowance is token-weighted, cache reads count at some discounted weight (not zero, not necessarily full), and writes count too. Anthropic has never published the formula, and the #75290 numbers are one user's estimate at API prices, not an official weight. Treat any per-token quota arithmetic as an estimate; only live `/status` observation on our own account settles it.

## 4. Waiting sessions, background work, and keep-alive

- A session that waits for a background task sends **no model request** while it waits. The main session is re-invoked when the background subagent completes ("A background subagent's results reach Claude as a completion notification in a later turn" — sub-agents docs, search excerpt of code.claude.com/docs/en/sub-agents; the same page's cached behavior is confirmed by the prompt-caching page). An idle gap longer than the TTL therefore ends with a cold cache: "After a long enough gap, the next request recomputes the full input and re-establishes the cache, which is why the first turn back after stepping away can be noticeably slower" (prompt-caching page, reader).
- `ScheduleWakeup` (the `/loop` dynamic-mode tool) is the closest thing to a keep-alive: it sleeps 60–3600 seconds and then fires a prompt back into the session — that fire is a real API request that reads the context and refreshes the TTL. "The runtime clamps to [60, 3600]" (issue #61522, reader). A request to extend the cap to 8h/24h was "Closed as not planned" with no maintainer response (issue #61522). Its documented purpose is `/loop` self-pacing and "Waiting for a long build, deploy, or test run" — using it as a pure cache keep-alive is off-label but works mechanically. [partly guess]
- `Monitor` arms a watch on a background task and re-invokes the main session between turns when the watched event fires (documented for the main session). Known bugs: Monitor events and task-completion notifications never wake an *idle teammate* in agent teams (issue #77300), and subagents that arm a Monitor can be reported `completed` while still waiting, with terminal events dropped (issue #86085, author "hit this six times in one session, at a cost of roughly 1.2M wasted subagent tokens"). Both issues were read as search excerpts, not via the reader. [fact as reported, unverified]
- No documented keep-alive tool exists. Nothing in the docs says "keep the cache warm while waiting". The agent-view doc says an actively working session's row updates "without sending a model request", and "Once a session finishes and sits unattached for about an hour, the supervisor stops its process" (search excerpt of agent-view page) — so an idle background session is not even guaranteed to keep its process after ~1 hour.
- The subagent itself warms its own cache: "A subagent starts its own conversation ... Its first request doesn't read the parent's cache ... and it warms a cache of its own across its turns. Subagents fall outside the main-conversation TTL bucket, so they get five minutes even on a subscription until you choose a longer one" (prompt-caching page, reader). So a long opencode run of 30+ minutes loses its own cache between its own turns unless `subagentPromptCacheTtl=1h` is set — but opencode is a different harness entirely; this only matters for Claude subagents.
- Conclusion for our case: while the main thread waits 5–60 minutes for an opencode worker, it is silent, and the cache (1h TTL on subscription) survives up to 60 minutes of that silence for free. Beyond 60 minutes the cache is cold.

## 5. The arithmetic

API list prices for Opus 5.5 (section 1). Scenario: main thread waits, then continues the conversation. Cost of the continuation turn only (output ignored, same in all options).

Context = 100k tokens:

| Option | What happens | API cost |
| --- | --- | --- |
| (a) wait 2 h idle, then continue | cache cold; fresh 1h-TTL write of 100k | 100k × $8/MTok = **$0.80** |
| (a′) same, 5m-TTL write | | $0.50 |
| (b) wake every 55 min ×2 | each wake reads 100k at $0.20/MTok + tiny turn | 2 × $0.02 = **$0.04** |
| (c) end session, fresh start from plan files (~30k) | fresh 1h write of 30k | 30k × $8/MTok = **$0.24** |

Context = 300k tokens:

| Option | API cost |
| --- | --- |
| (a) fresh 1h write | 300k × $8 = **$2.40** (5m write: $1.50) |
| (b) 2 keep-alive reads | 2 × 300k × $0.20 = **$0.12** |
| (c) fresh 30k session | **$0.24** |

Break-even wait time: a keep-alive wake every 55 minutes costs ~$0.022/h at 100k and ~$0.066/h at 300k (Opus 5.5, 0.05x read). It beats the fresh 1h write of the full context as long as the total wait is under roughly **36 hours at 100k** and **36 hours at 300k** (write $0.80 / $2.40 ÷ per-hour read cost). [guess: assumes byte-identical prefix each wake, i.e. no invalidation in between.] Versus restarting from plan files (option c), keep-alive loses once the wait exceeds ~11 hours at 100k (0.24 / 0.022) and ~3.6 hours at 300k. All cash numbers are API; on a subscription the cash is $0 either way.

Subscription effect: unknown weight (section 3). Directionally, one keep-alive request per hour reads the context at cache-read weight, while a cold restart re-writes the whole context at write weight and the *next* turn still has to read it. If cache reads count at even a fraction of write weight, the keep-alive is cheaper against the quota too. [guess] But issue #75290 shows cache reads can drain quota measurably on Max, so a keep-alive is not free against the limit — it just costs far less than a cold restart.

Key nuance for our 5–60 minute waits: on a subscription the main conversation already has the 1-hour TTL. A wait of up to ~60 minutes costs nothing and needs no keep-alive; the first turn back hits the cache. Only waits longer than an hour need a decision. Also note the clock nuance: the TTL runs from the request, and a long in-flight turn eats into it [fact from technspire.com, search excerpt, not read via the reader — mark as lead, not source].

## 6. Cache misses in Claude Code, and how to see hits

From the prompt-caching page (reader):

- The most common invalidation is "a server connecting or disconnecting mid-session" of an MCP server — "a stdio server's process exits, an HTTP session expires, or a server reconnects automatically"; a server can also push a tool-list update.
- Anything that changes tools, system prompt, or the model breaks the byte-identical prefix. Claude Code "never invalidates the cache for a plugin's skills, commands, agents, hooks, monitors, or themes" — it appends their content, so the next request pays for the addition but still reads the prefix.
- `/compact` and resume-replay reprocess history; `/rewind` is cheaper ("truncates back to a prefix that is already cached").
- After a model switch the prefix differs, so the first turn on the new model is a full write. [guess, from the byte-identical-prefix rule]
- `/model` asks for confirmation "only while the cache is still warm" — a built-in warmness signal.
- Seeing hits: run `claude -p "hello" --output-format json` and read `usage.cache_creation` (`ephemeral_1h_input_tokens` vs `ephemeral_5m_input_tokens`) to confirm which TTL writes used. `/usage` adds a `Prompt cache (main)` line with "the session's hit ratio, miss count, and whether the cache is warm right now", and "names the likely cause of the last miss when Claude Code can identify one, for example `likely cause: tool definitions changed`". "A high read-to-creation ratio means caching is working well."
- Aggregate view: `ccusage` reads the transcript JSONL (`~/.claude/projects/`) and reports cache creation/read tokens and API-equivalent cost (prior report claude-max-vs-openrouter.md section 6; the tool is mature, 18.8k stars). Our own measured spend: September 2026 Claude Code ≈ $804 API-equivalent (same report).

## Options

### A. Do nothing within 60 minutes; wake only past 1 hour (recommended baseline)

Subscription main conversation already has the 1h TTL. For waits ≤ ~55 min, wait silently. For longer waits, fire one `ScheduleWakeup` (or a manual nudge) every ~55 minutes until the worker finishes.

- Gains: zero build effort for ≤1h waits (TTL already covers it); past 1h, one cheap cache-read request per hour keeps the whole context warm — $0.02–$0.07/h at API prices, and almost certainly quota-cheaper than a cold restart.
- Costs: ScheduleWakeup is a `/loop` tool, not a documented keep-alive; using it from the main thread mid-task is off-label. Each wake is a model turn that consumes a little quota and can itself derail (the woken turn must know to go back to sleep). Unwoken waits >1h cost $0.80–$2.40 per cold restart (API) plus the quota of a full rewrite.
- Risks: ScheduleWakeup clamp is 60–3600 s, so a 55-min cadence is near the ceiling; a missed wake = cold cache anyway. Cache-read quota weight unknown (section 3).

### B. Always end the session and restart from plan files

- Gains: zero cache management; the fresh session is small (20–40k) and cheap to write ($0.15–$0.24); matches our "new thread is cheaper than an old thread whose prompt cache expired" practice for *very* long gaps; immune to invalidation surprises.
- Costs: loses conversational context and nuance that the plan files don't capture; a restart turn itself costs a full write plus the model re-reads the project; for waits of 1–3 hours it is more expensive than keep-alive at 300k context ($0.24 vs $0.12–$0.20) and loses continuity.
- Risks: quality risk — the restarted thread decides differently without the context in its head.

### C. Keep a heartbeat every <5 min (5m-TTL world, e.g. usage overage or API key)

Once in usage overage the main conversation drops to 5m TTL; a cold restart then costs a 5m write ($0.50 at 100k) per gap.

- Gains: keeps the cache warm through overage or on API-key auth.
- Costs: 12 requests/hour — noisy, quota-consuming, and against the spirit of "keep each session small". Only worth it if the context is huge and the wait is long. [guess]

## Recommendation

Option A. The deciding criteria: the TTL we already have (subscription main conversation = 1h, so 5–60 minute waits — our actual case — need nothing), the cash arithmetic (keep-alive beats cold restart for any wait under ~36 h at 100k context), and effort (one wake per hour is the only build). Concretely: waits ≤55 min → do nothing; waits >1h → one ScheduleWakeup-style wake every ~55 min or, past ~3h at very large context, prefer option B (restart from plan files). Never rely on keep-alive in usage overage — there the TTL is 5m and the arithmetic flips toward B. Verify the quota effect with `/usage` and `ccusage blocks` after the Max upgrade, since Anthropic publishes no cache-weight formula.

## What I could not find out

- The official weight of cache reads/writes against Pro/Max 5-hour and weekly limits — Anthropic publishes no formula; only community issue #75290 (closed, unanswered) speaks to it.
- Whether Anthropic intends ScheduleWakeup as a keep-alive — no doc says so; the feature request to extend its cap was closed as not planned without comment.
- Whether the env-vars rows for `ENABLE_PROMPT_CACHING_1H` / `FORCE_PROMPT_CACHING_5M` / `DISABLE_PROMPT_CACHING` read exactly as quoted — the env-vars page truncated in the reader before those rows; the quotes come from the prompt-caching page (reader) and GitHub issue search excerpts.
- The exact current ScheduleWakeup tool text (leaked system-prompt copies circulate; I did not treat them as sources).
- Whether a `Monitor`-armed main session waiting on a worker stays reliably woken — documented for the main session, but bugs exist for teammates/subagents (#77300, #86085, search excerpts).

## Search log

- websearch "Anthropic prompt caching documentation 1-hour cache TTL pricing refreshes": 3 relevant hits (API docs, technspire deep-dive, TTL-regression postmortem).
- websearch "Claude Code prompt cache 1 hour TTL DISABLE_PROMPT_CACHING env": 5 relevant hits (code.claude.com prompt-caching, env-vars, issues #48082, #49139, #48090).
- websearch "Claude subscription usage limits cache reads count 5-hour limit": 4 relevant hits (support articles, issue #75290, pricing page, Reddit thread).
- websearch "Claude Code ScheduleWakeup monitor prompt cache": 4 relevant hits (issue #61522, cc-viewer tool doc, changelog, genisisiq analysis).
- websearch "Claude Code background Monitor idle cache expires": 5 relevant hits (prompt-caching, sub-agents, agent-view, #77300, #86085).
- skills.sh API "claude code prompt cache" and "claude code keep alive": 0 relevant skills (generic coding skills only).
- Not run: gh search (the GitHub issues were found by websearch and read via the reader); no npm/PyPI candidates were relevant beyond ccusage, already covered in claude-max-vs-openrouter.md.
