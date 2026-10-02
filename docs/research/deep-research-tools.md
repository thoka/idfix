---
checked: 2026-10-02
recheck: 1m
decisions: []
---

# Deep research tools for expensive decisions

A Claude Code session can start a CLI or an HTTP call. This report lists the
established deep research tools that fit, how a script calls them, what a report
costs, and what the quality evidence says. Read 2026-10-02. Every cited page
was read on that date through the page reader, unless marked otherwise.

## Criteria

- Callable from a script or a Claude Code session (HTTP API, CLI, or MCP), and
  the report comes back as text or Markdown.
- Price per report is known: list price plus a real per-report number.
- Quality evidence: public benchmarks with dates and a named runner.
- Citations in the report (claim-to-source links).
- Run time, limits, maturity, and data use (does the provider train on input).
- Quality first, per the user rule "a good model makes the result".

## Big change found during this research

- Perplexity ended Sonar Chat Completions on 2026-09-27. Deep research moved to
  the Agent API (`POST https://api.perplexity.ai/v1/agent`) with presets; the
  migration page says "Sonar Deep Research → `high` preset … often at a lower
  per-request cost than Sonar Deep Research" and points to `xhigh` for
  state of the art (read 2026-10-02,
  https://docs.perplexity.ai/docs/sonar/models/sonar-deep-research — now serves
  the migration page).
- OpenAI lists 2026-07-23 as the shutdown date for `o3-deep-research` and
  `o4-mini-deep-research`, with `gpt-5.6-sol` as the replacement (read
  2026-10-02, https://developers.openai.com/api/docs/guides/deep-research).
  OpenRouter no longer serves `openai/o3-deep-research` (model page 404, read
  2026-10-02; absent from the `api/v1/models` list, checked 2026-10-02). So the
  "OpenAI deep research model" is being replaced; the replacement's price was
  not on the pages read.

## Candidates

### Hosted APIs

**Parallel Task API** — https://parallel.ai/pricing, https://docs.parallel.ai/task-api/examples/task-deep-research (both read 2026-10-02)

1. Calling: `POST https://api.parallel.ai/v1/tasks/runs` with `{"input": "...", "processor": "ultra"}`; SDK equivalent `client.task_run.create(...)`. Async: poll, webhook, or SSE. `text` output mode returns a "markdown report with in-line citations". A Claude Code session can start it with curl and poll until done.
2. Price: per request, not per token. Pro $100/1k = $0.10 per run, 3–9 min. Ultra $300/1k = $0.30, 5–25 min. Ultra2x $0.60, Ultra4x $1.20, Ultra8x $2.40. Price per request range $0.005–$2.40.
3. Quality: DeepResearch Bench (below) does not list Parallel. No independent benchmark found. [guess: quality near Gemini/OpenAI DR tiers by positioning, unproven.]
4. Citations: yes — `basis` object with citations, excerpts, confidence per field; sample run had "610 total citations".
5. Run time up to 45 min; input limit 15,000 characters; priced per request so cost is known before the run; mature product (SOC2 listed). Data use not stated on the pages read.

**Perplexity Sonar Deep Research / Agent API** — https://docs.perplexity.ai/docs/getting-started/pricing, https://docs.perplexity.ai/docs/sonar/models/sonar-deep-research (both read 2026-10-02)

1. Calling: was OpenAI-compatible chat completions; since 2026-09-27 the Agent API (`/v1/agent`) with presets `high` (maps from Sonar Deep Research) and `xhigh`. OpenRouter still lists `perplexity/sonar-deep-research` at $2/$8 per M plus $5 per 1k searches (https://openrouter.ai/perplexity/sonar-deep-research, read 2026-10-02), so an OpenRouter call needs one API call only — but the slug may stop working; [guess: prefer the native Agent API or verify the OpenRouter slug before relying on it].
2. Price: sonar-deep-research was $2 input / $8 output / $2 citation / $3 reasoning per 1M tokens, $5 per 1k searches, no request fee (pricing page, read 2026-10-02). A docs example (seen in search excerpts only, page since replaced; unverified) showed a 21-search report at $0.816 total. [guess: roughly $0.3–$1.5 per report at the old prices.]
3. Quality: "Perplexity Deep Research" RACE 42.25, citation accuracy 90.24 (best of the agents) on DeepResearch Bench, read 2026-10-02.
4. Citations: the model returns a `citations` array of URLs (search excerpt, unverified after migration).
5. Context 128k; OpenRouter shows 95 s median latency, 80% uptime. Data use: not stated on pages read.

**Google Gemini Deep Research agent** — https://blog.google/innovation-and-ai/models-and-research/gemini-models/next-generation-gemini-deep-research/ (read 2026-10-02)

1. Calling: Interactions API, single call, background execution, public preview on paid Gemini API tiers, `deep-research-preview-04-2026` and `deep-research-max-preview-04-2026` (agent names from the search excerpt of https://ai.google.dev/gemini-api/docs/deep-research, page itself could not be read — see "Could not find out"). Supports Google Search, URL context, code execution, MCP, file search.
2. Price: the docs page (unreadable) gave estimates of ~$1–$3 per task for Deep Research and ~$3–$7 for Deep Research Max — search excerpt only, unverified.
3. Quality: best score of the commercial agents on DeepResearch Bench: Gemini-2.5-Pro Deep Research RACE 48.88 and 111 effective citations (read 2026-10-02). The new 3.1 Pro agents are newer and not yet on the leaderboard.
4. Citations: "professional-grade, fully cited analyses" (blog, read 2026-10-02).
5. Preview status, so API may change; 1M input context; data use not stated on pages read.

**OpenAI o3-deep-research** — https://developers.openai.com/api/docs/models/o3-deep-research, https://developers.openai.com/api/docs/guides/deep-research (both read 2026-10-02)

1. Calling: Responses API with web search, file search, or MCP as data source; `max_tool_calls` to cap cost; background mode recommended ("tens of minutes"). Output has inline citations with URL annotations. Shut down 2026-07-23 per the guide; replacement `gpt-5.6-sol` (price not found, see below).
2. Price while it lasted: $10 input / $2.50 cached input / $40 output per 1M; web search billed per call. [guess: a typical report cost $2–$10; no measured number on the pages read.]
3. Quality: OpenAI Deep Research RACE 46.98, best instruction-following 49.27 on DeepResearch Bench; 51.5% on BrowseComp vs 0.6–9.9% for GPT-4o/o1 (https://openai.com/index/browsecomp/ — search excerpts and the arXiv page read only via excerpts; the numbers appear in the unread pages and are attributed to OpenAI, April 2025 — treat as secondary).
4. Citations: yes, inline URL annotations.
5. Note: this model is trained for benchmarks and BrowseComp warns of that (footnote). Not on OpenRouter any more.

**Exa Deep Search / Agent API** — https://exa.ai/pricing?tab=api (read 2026-10-02)

1. Calling: `/search` with `type: deep|deep-lite|deep-reasoning` (sync, seconds), and an async Agent endpoint for research tasks; Bearer auth; structured outputs supported.
2. Price: deep search $12–15 per 1k requests = $0.012–$0.015 per call. Agent fixed effort: $0.012 (minimal) to $1.00 (xhigh) per run; metered `auto` defaults to a $5 cap, `ultra` to $20.
3. Quality: no independent deep-research benchmark found for Exa. Its own blog (search excerpt) positions Deep as agentic search, not full reports. [guess: a search-tier tool, not a report generator.]
4. Citations: "grounded by web citations" (product page excerpt, unverified).
5. Very fast for the search tiers; pay-as-you-go, $10 monthly free credits. Data use: not stated on pages read.

**OpenRouter** — https://openrouter.ai/perplexity/sonar-deep-research (read 2026-10-02)

OpenRouter offers `perplexity/sonar-deep-research` ($2/$8/M, $5 per 1k searches, one provider). It does not offer `openai/o3-deep-research` (404, read 2026-10-02) and no Gemini deep research agent. So for this project's existing OpenRouter key, Sonar Deep Research is the only one-model deep research option — but see the migration warning above.

### Products without an API (run by hand)

**ChatGPT Deep Research** — https://help.openai.com/en/articles/10500283-deep-research (read 2026-10-02)

Called from the ChatGPT UI (`/deepresearch`). Usage varies by plan, fixed allowances reset every 30 days; the help page gives no numbers. Third-party comparisons (search excerpts only, unverified) say Plus ≈10 reports/month at $20/month and Pro ≈120/month at $200/month. Reports can be exported as Markdown and pasted to Claude Code by hand. Quality: the same family that scored 46.98 RACE / 51.5% BrowseComp. Citations: yes.

**Claude Research in claude.ai** — https://claude.com/pricing/ (read 2026-10-02)

"Research" is included on Pro and Max plans and draws from the same 5-hour/weekly usage pool as Claude Code; over-limit use bills as usage credits at API rates, and "Research sessions may consume tokens more quickly" (https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans, read via search excerpt only). No API. Quality: no DeepResearch Bench entry for Claude Research; an independent paper (arXiv 2508.10152, search excerpt) found Claude-DR scored 0% on BrowseComp-style exact answers — but that metric punishes report-style output, so it says little about report quality. Citations: yes, inline.

**Gemini Deep Research in the app** — included with Google AI plans (search excerpts only, unverified; ~$20/month plan). Same agent family as the best-scoring Bench entry. No API.

### Open-source frameworks (own model + own search)

**gpt-researcher** — https://github.com/assafelovic/gpt-researcher (read 2026-10-02)

- ~29.9k stars, Apache-2.0, active (v3.6.1 on 2026-08-24, v3.7.0 on 2026-09-26 per releases page excerpts). Mature.
- Calling: Python package (`GPTResearcher.conduct_research()` / `write_report()`), REST server on :8000, Docker; MCP server in a separate repo (gptr-mcp). Needs `OPENAI_API_KEY` (or any OpenAI-compatible base URL) plus a search key such as `TAVILY_API_KEY`. A Claude Code session can run the REST server or MCP and get Markdown reports.
- Cost per report: your own model + search tokens. [guess: $0.05–$0.50 depending on model; no measured number on the pages read.]
- Quality: no leaderboard entry found. The independent ODR paper (arXiv 2508.10152, search excerpt) shows open-source DRAs well behind ChatGPT-DR on BrowseComp-style tasks.

**langchain-ai/open_deep_research** — https://github.com/langchain-ai/open_deep_research (read 2026-10-02)

- 12.7k stars, MIT — but "archived by the owner on Aug 21, 2026. It is now read-only." Not recommended for a new dependency.
- Calling: LangGraph server (`langgraph dev`), API on :127.0.0.1:2024; any model via `init_chat_model`, Tavily by default, MCP compatible. Repo's own eval warning: "~$20-$100" for 100 examples, i.e. $0.20–$1.00 per report.
- The LangChain team has moved successor work elsewhere; the repo README points at the DeepResearch Bench leaderboard for quality claims (its own entry is not on the read leaderboard table).

### Skills from skills.sh (installable into Claude Code)

Searched skills.sh on 2026-10-02 (`deep research`, `openai deep research`,
`perplexity`, `gemini deep research`). Two queries for OpenAI/Gemini deep
research returned only skills with under 100 installs each — none established.
The relevant hits, with their pages read 2026-10-02:

**parallel-deep-research** (parallel-web/parallel-agent-skills, 15.0k installs)
— https://www.skills.sh/parallel-web/parallel-agent-skills/parallel-deep-research
Wraps the Parallel Task API (candidate above) in a CLI: `parallel-cli research
run "$ARGUMENTS" --processor pro-fast --text --no-wait --json`, processor tiers
pro-fast/ultra-fast/ultra, "Outputs formatted markdown report and JSON
metadata", async with polling. Needs a Parallel API key. This is the missing
integration piece for option 1: a skill plus CLI instead of a hand-written
wrapper.

**firecrawl-deep-research** (firecrawl/firecrawl-workflows, 35.1k installs)
— https://www.skills.sh/firecrawl/firecrawl-workflows/firecrawl-deep-research
For "report-scale research: a rigorous, cited synthesis". Backend is
Firecrawl's own service (its search/paper index), so it needs a Firecrawl key
and bills Firecrawl credits. Firecrawl is not a deep research API in the sense
above; the skill orchestrates its crawl/search. No quality benchmark found.

**deep-research** (199-biotechnologies/claude-deep-research-skill, 10.0k
installs) — https://www.skills.sh/199-biotechnologies/claude-deep-research-skill/deep-research
A pipeline skill (evidence persistence, claim-level verification). The page
shows it steering simple lookups back to the agent's own WebSearch — [guess:
it orchestrates built-in search, no paid API; the truncated page does not show
the backend]. Quality depends on the agent's own search, not on a deep research
model.

**deep-research** (samber/cc-skills, 2.7k installs)
— https://www.skills.sh/samber/cc-skills/deep-research
Pure orchestration prompt: "Fan out 3–20 parallel sub-agents for research
evidence gathering", no external service or keys shown. Uses Claude Code's own
sub-agents and web search.

**deep-research** (bytedance/deer-flow, 2.6k installs)
— https://www.skills.sh/bytedance/deer-flow/deep-research
A methodology prompt over web research, no CLI, no API keys shown. The deer-flow
repo has 83.3k stars but the skill itself is a prompt, not a deep research
backend.

Platform note: skills.sh lists these skills generically for Claude Code,
Cursor, Codex and others; opencode is not in its agent list. Installation is
via `npx skills add <repo> --skill <name>`, which writes a SKILL.md into the
agent's skills folder, so an opencode install likely works by hand-copying the
file [guess].



| Option | Call from script | Price per report | Quality evidence | Citations | Run time | Maturity / notes |
|---|---|---|---|---|---|---|
| Parallel Task API (ultra) | HTTP, async, Markdown out | $0.30 flat (pro $0.10, ultra8x $2.40) | none public | yes, per claim + confidence | 5–25 min | mature, cost known up front |
| Perplexity (Sonar DR → Agent API `high`/`xhigh`) | HTTP; also via OpenRouter | ~$0.3–$1.5 [guess] | RACE 42.25, best citation accuracy 90.24 | yes | ~1.5–5 min | API just migrated; churn risk |
| Gemini Deep Research agent | Interactions API, preview | ~$1–$3 (docs unread, unverified) | RACE 48.88 (best commercial) | yes | minutes–tens of minutes | preview; docs unreadable for us |
| OpenAI o3-deep-research | Responses API | $2–$10 [guess] | RACE 46.98; 51.5% BrowseComp | yes, inline | tens of minutes | shutdown 2026-07-23; do not adopt |
| Exa Deep Search / Agent | HTTP, sync/async | $0.012–$1.00 | none found | yes | 4–40 s (search tiers) | search-tier, not full reports |
| ChatGPT Deep Research (by hand) | UI only | $20/month ≈ 10 reports (3rd party, unverified) | same OpenAI family | yes | 5–30 min | no API; export by hand |
| Claude Research (by hand) | UI only | inside existing Pro/Max pool | no public benchmark | yes | minutes–tens of minutes | shares quota with Claude Code |
| gpt-researcher | Python/REST/MCP | own tokens, ~$0.05–$0.50 [guess] | none public | yes | minutes | mature, active |
| open_deep_research | LangGraph server | $0.20–$1.00 (repo own figure) | repo claims Bench parity; not on leaderboard | yes | minutes | archived 2026-08-21; avoid |
| parallel-deep-research skill | `parallel-cli`, installed as Claude Code skill | same as Parallel ($0.10–$0.30) | none public (backend same as Parallel row) | yes | 0.5–25 min | 15k installs; adds polling CLI |
| firecrawl-deep-research skill | skill + Firecrawl API | Firecrawl credits, unknown | none public | yes | unknown | 35k installs; search backend, not a DR model |
| orchestration skills (199-bio, samber, deer-flow) | prompt/sub-agents only | own tokens | none | prompt-dependent | minutes | no dedicated DR backend |

## Options for our setup

Judged by the criteria, quality first, then price per report, then integration effort for a Claude Code session.

1. **Parallel Task API, `ultra` in `text` mode — $0.30 per report, via the parallel-deep-research skill.** The skill (15k installs) plus `parallel-cli` is a ready-made integration: Claude Code installs the skill, calls `parallel-cli research run ... --text`, and gets a Markdown report with per-claim citations. The price is fixed before the run, which fits the "estimate the cost before a paid run" rule. The deciding criterion is cost transparency plus a supported integration path; its weakness is the lack of independent benchmark evidence. Best first choice; validate quality on one real decision before trusting it.
2. **Gemini Deep Research agent via Interactions API — ~$1–$3 per report.** Best measured quality of the commercial agents, fully cited. Decided by quality, which the user's rule ranks first. Risks: preview status, and we could not read its docs from here, so integration effort is unproven. Worth a spike after option 1, or first if a benchmark-level decision justifies it.
3. **Perplexity Agent API (`xhigh` preset) through OpenRouter while the slug lasts — ~$0.3–$1.5 per report [guess].** Uses the key we already have, one HTTP call, citations included, fastest reports (~2 min). Decided by integration cost; weakness is the API churn found on 2026-09-27 and unverified per-report cost after migration.

The products without an API stay a manual fallback: ChatGPT Plus/Pro or the Gemini app run by hand, report pasted into Claude Code. The open-source frameworks do not compete on quality for expensive decisions; gpt-researcher is the only one to keep on the radar, open_deep_research is archived.

## Could not find out

- The Gemini API deep research docs page (ai.google.dev) could not be read from here (transport/authorization errors on four attempts, read tried 2026-10-02). Its per-task cost estimates (~$1–$3, ~$3–$7) come from search excerpts only and are unverified.
- Price and benchmarks of `gpt-5.6-sol`, the OpenAI replacement for o3-deep-research.
- Per-report cost of Perplexity after the 2026-09-27 Agent API migration; the old docs example ($0.816) is no longer on the live page.
- Training-on-input policy for Parallel, Exa, Google, and Perplexity — not stated on the pages read; needs the provider data-use pages.
- The exact backend and key needs of firecrawl-deep-research and 199-biotechnologies/deep-research — skills.sh truncates each SKILL.md; the raw files in the repos were not read.
- Whether `npx skills add` supports opencode directly — skills.sh lists no opencode column; hand-copying the SKILL.md should work [guess].
- Any independent benchmark of Parallel Task API, Exa Deep, or gpt-researcher on DeepResearch Bench or BrowseComp.
- Current ChatGPT plan deep research quotas (help page no longer publishes numbers); the ~10/month Plus figure is third-party and from 2026-04.
