---
checked: 2026-10-02
recheck: 1m
decisions: []
---

# Self-deployable open-source deep research tools

Which open-source deep research tools to test against Gemini Deep Research on
our machine (WSL2, Docker, models via OpenRouter, no paid search API key yet).
Read the earlier report `deep-research-tools.md` first; this one covers only
self-hostable tools that we can run ourselves. Unless marked otherwise, sources
were read on 2026-10-02 through the page reader (2 pages), the GitHub REST API
(`gh api`), the skills.sh API (`curl`), or the OpenRouter models API (`curl`).
GitHub code search did not work (401, rate limited), so some file listings came
from `gh api repos/.../contents`.

## Criteria

- Report quality: benchmark evidence with dates and a named runner; DeepResearch
  Bench RACE overall where available.
- Works with OpenRouter (OpenAI-compatible endpoint) for all model roles.
- Search backend: runs without a paid key (SearXNG, DuckDuckGo, free tiers).
- Callable from a script: CLI, REST API, or Python function; Markdown report
  with citations out.
- Setup effort on WSL2 with Docker and mise; known failure modes from issues or
  docs.
- Maturity: stars, last commit, license, archived or not.

## Candidates found

Search queries used: GitHub "deep research" by stars (30 hits, ~12 relevant),
topic `deep-research` (30 hits, ~10 relevant), skills.sh `deep research` and
`deep-research` (20 hits each, mostly Claude-Code skills, not self-hosted
backends). OpenRouter models list checked for `tongyi`, `mirothinker`,
`deepresearch` — none present. Not every hit is listed below; products without
an API, skills that wrap hosted APIs, and RAG tools are out of scope (they were
covered in `deep-research-tools.md`).

### gpt-researcher (assafelovic/gpt-researcher)

1. Maturity: 29,871 stars, Apache-2.0, last push 2026-10-01, not archived
   (`gh api repos/assafelovic/gpt-researcher`). Active.
2. Quality: no DeepResearch Bench entry (checked the leaderboard CSV via reader,
   2026-10-02). Self-hosted, so no third-party score found.
3. Models: supports OpenAI, Anthropic, Gemini, Ollama, LiteLLM gateway and
   "others" (https://gptr.dev, websearch excerpt, not read — open support for
   OpenAI-compatible endpoints is documented but I did not read the exact env
   var page). Fast/companion model roles configurable.
4. Search: `RETRIEVER` env var, ~19 engines. Keyless: DuckDuckGo, Searx/SearXNG,
   arXiv, Semantic Scholar, PubMedCentral, OpenAlex (optional email)
   (https://docs.gptr.dev/docs/gpt-researcher/search-engines, read via reader
   2026-10-02). Default Tavily needs a key; its free tier gives 1,000 credits
   per month [guess: standard Tavily free tier, unverified this year].
5. Run: Python package, REST server on :8000, Docker image, MCP server in a
   separate repo (gptr-mcp). Script can POST a query and get Markdown back
   (covered in `deep-research-tools.md`).
6. Effort on our machine: low — `docker compose up`, set `OPENAI_API_KEY` +
   `OPENAI_BASE_URL` to OpenRouter, `RETRIEVER=duckduckgo` or a local SearXNG
   container. Known failure modes: DuckDuckGo rate limits on long runs
   [guess — not verified from issues because code search was unavailable];
   SearXNG needs its own container.
7. Cost: own model + search tokens; `deep-research-tools.md` estimates
   $0.05–$0.50 per report [guess].

### open_deep_research (langchain-ai/open_deep_research)

1. Maturity: 12,684 stars, MIT, **archived 2026-08-21**, read-only
   (`gh api repos/langchain-ai/open_deep_research`).
2. Quality: the strongest measured open framework. DeepResearch Bench
   leaderboard CSV (read via reader 2026-10-02,
   https://huggingface.co/spaces/muset-ai/DeepResearch-Bench-Leaderboard/raw/main/data/leaderboard.csv):
   `langchain-open-deep-research-gpt-5` 49.33 overall; with GPT-4.1 backbone
   43.44. For scale: gemini-2.5-pro-deepresearch 49.71, openai-deepresearch
   46.45, claude-research 45.00. The ICLR paper (search excerpt only, not read
   through the reader) says ODR with GPT-5 reaches 50.60 and "surpasses even
   Gemini-2.5-Pro Deep Research". These runs used Tavily search.
3. Models: any via `init_chat_model`; OpenRouter should work as an
   OpenAI-compatible provider.
4. Search: Tavily by default. No keyless engine confirmed from what I read.
5. Run: LangGraph server (`langgraph dev`), API on :2024. Script can start a
   run and poll for the Markdown report.
6. Effort: medium (LangGraph CLI + env). Risk: archived, so bugs stay fixed
   nowhere; framework code can still be copied. Repo's own eval cost warning:
   $0.20–$1.00 per report (`deep-research-tools.md`).

### Tongyi DeepResearch (Alibaba-NLP/DeepResearch)

1. Maturity: 20,000 stars, Apache-2.0, last push 2026-02-27, not archived
   (`gh api repos/Alibaba-NLP/DeepResearch`). Model weights: Tongyi-30B-A3B
   (30.5B total, 3.3B active per token) on HuggingFace (README, read via
   `gh api`).
2. Quality: best fully-open entry on DeepResearch Bench: 40.46 overall (leader
   board CSV, read via reader). The ICLR paper (search excerpt) says it is
   "comparable to Perplexity Deep Research" but "challenges remain in
   generating high-quality long-form reports consistently". Also state of the
   art on BrowseComp etc. per the README (self-reported, read 2026-10-02).
3. Models: it IS the model — needs a 30B-A3B served. Not on OpenRouter (checked
   `api/v1/models`, 2026-10-02). Serving on WSL2: 3.3B active parameters fits
   in ~8 GB VRAM quantized or runs on CPU [guess]. Can also be called through
   any provider that hosts it — none found.
4. Search: the repo expects an agentic search environment; the README points to
   demos and the bailian service. Which keyless search stack works locally I
   could not confirm from the README text I read.
5. Run: repo ships inference scripts and a WebAgent framework; deployment
   section in the README is aimed at self-hosting.
6. Effort: high — serve the model (vLLM/llama.cpp) plus wire up search tools on
   WSL2. Not archived but quiet since February 2026.

### MiroThinker (MiroMindAI/MiroThinker)

1. Maturity: 8,416 stars, Apache-2.0, last push 2026-07-06, not archived
   (`gh api repos/MiroMindAI/MiroThinker`). MiroThinker-1.7 released 2026-03-11.
2. Quality: README claims 69.8% BrowseComp and 80.8% GAIA-Val-165 for
   MiroThinker-v1.5-235B, 88.2 for the proprietary MiroThinker-H1 (README, read
   via `gh api` 2026-10-02). Not on the DeepResearch Bench CSV.
3. Models: the agent model is theirs (30B and 235B variants), served via an
   OpenAI-compatible base URL in their MiroFlow framework; the summary LLM can
   be any small model via `SUMMARY_LLM_BASE_URL` (README, read via `gh api`).
   Their models are not on OpenRouter (checked, 2026-10-02).
4. Search: minimal config needs Serper (paid key), Jina (free tier), E2B
   sandbox (free tier). No keyless/SearXNG path in the minimal setup I read.
5. Run: Python/uv, `apps/miroflow-agent`, CLI over MCP servers; reports from
   the online service dr.miromind.ai (hosted, not self-hosted).
6. Effort: high — serve a 30B+ model locally or find a hosted endpoint, plus
   three API keys (Serper is paid). Three or more keys contradict our "no paid
   search key yet" constraint.

### local-deep-research (LearningCircuit/local-deep-research)

1. Maturity: 9,147 stars, MIT, last push 2026-10-02 (same day), not archived;
   published on PyPI and Docker Hub (`gh api` + README read via `gh api`).
   Very active.
2. Quality: self-reported ~95% SimpleQA (n=500) and 77% xbench-DeepSearch
   (n=100) fully local on one RTX 3090 with Qwen3.6-27B (README read via
   `gh api`; third-party post linked in README). Not on the DeepResearch Bench
   CSV. xbench-DeepSearch 77% is above Tongyi's 74.8 FRAMES-era claims but on
   different benchmarks; report-style quality unmeasured.
3. Models: any LLM via an OpenAI-compatible endpoint (README pip-install
   section: "any OpenAI-compatible LLM endpoint"), so OpenRouter works.
4. Search: SearXNG container by default — fully keyless. The README warns that
   localhost SearXNG URLs must be marked operator-approved since v1.10.3.
5. Run: `docker compose up` or pip; web UI on :5000; also usable as a Python
   library. Script-driven report extraction: the web UI is the main surface;
   API use is possible but I did not confirm an HTTP endpoint for reports.
6. Effort: low-medium. WSL2 failure mode documented in the README: `--network
   host` fails on Docker Desktop/WSL2 and silently breaks SearXNG/Ollama
   connectivity; the README gives a compose-based recipe instead.
7. Cost: own tokens only.

### deer-flow (bytedance/deer-flow)

1. Maturity: 83,328 stars, MIT, last push 2026-10-02, very active. 2.0 is a
   ground-up rewrite as a "super agent harness"; the 1.x deep research
   framework lives on the `main-1.x` branch (README, read via `gh api`).
2. Quality: no DeepResearch Bench entry. It is a general harness, not a
   research-report benchmark contender.
3. Models: recommends Doubao/DeepSeek/Kimi; OpenAI-compatible endpoints
   generally work (not confirmed from the README excerpt I read).
4. Search: bundled providers DDG, Brave, Tavily, SearXNG, Serper (README, read
   via `gh api`) — DDG and SearXNG are keyless.
5. Run: Python 3.12 + Node 22 backend/frontend stack, or the deer-flow skill on
   skills.sh (2,635 installs) — the skill is a prompt, not a backend
   (`deep-research-tools.md`). 2.0 is a heavy harness; getting a script-driven
   Markdown report is not its main mode.
6. Effort: high for our purpose — the 2.0 harness is built for interactive
   use, and the report-focused code moved to the 1.x branch.

### dzhng/deep-research ("Open Deep Research")

1. Maturity: 19,742 stars, MIT, last push 2026-04-11, not archived (`gh api`).
2. Quality: none on leaderboards.
3. Models: OpenAI or any local OpenAI-compatible server via `OPENAI_ENDPOINT` +
   `OPENAI_MODEL` (README, read via `gh api`); OpenRouter should work.
4. Search: Firecrawl for search + scraping; a key is required unless
   self-hosting Firecrawl (`FIRECRAWL_BASE_URL=http://localhost:3002`, README).
   Self-hosting Firecrawl on our machine is possible (Docker) but adds a
   service and its own search quality problem.
5. Run: Node, CLI/API via docker compose; small (<500 LoC).
6. Effort: medium; the Firecrawl dependency is the blocker without a paid key.

### Others scanned, not shortlisted

- `jina-ai/node-DeepResearch` (5,235 stars, last push 2026-05): answer-seeking
  agent, needs Jina Reader/search; small scope.
- `u14app/deep-research` (4,692): UI wrapper around the dzhng approach; SSE API
  and MCP server; no benchmark.
- `zilliztech/deep-searcher` (8,292): research over private data, not web
  reports.
- `stanford-oval/storm` (31,557, last push 2025-09): Wikipedia-style article
  generation; needs search API keys (You.com/OpenAI APIs); quiet for a year.
- `modelscope/ms-agent` (4,406): open-source framework whose "Agentic Insight
  v2" scored 55.31 on DeepResearch Bench (repo README of
  ayanami0730/deep_research_bench via websearch excerpt — the leaderboard CSV
  itself does not list an ms-agent row with that score; treat the exact score
  as secondary until read). Windows/Linux Python, WebUI; setup cost unknown —
  a possible second-round candidate.
- `hyperresearch` (3,751, push 2026-10-01): converts Claude Code/Codex into a
  deep research agent — an orchestration prompt over the host agent's search,
  not a self-hosted backend; would test our own WebSearch quality, not a tool.

## Comparison table

Quality evidence is DeepResearch Bench RACE overall where the leaderboard has
it (CSV read via reader 2026-10-02). "Keyless search" = SearXNG or DuckDuckGo.

| Tool | Stars / last push | Bench evidence | Models via OpenRouter | Keyless search | Script → Markdown | WSL2 effort |
|---|---|---|---|---|---|---|
| gpt-researcher | 29.9k / 2026-10-01 | none on Bench | yes | DuckDuckGo, SearX | yes (REST/MCP) | low |
| open_deep_research | 12.7k / archived 2026-08-21 | 49.33 (GPT-5 backbone) | yes | Tavily only confirmed (free tier) | yes (LangGraph API) | medium |
| Tongyi DeepResearch 30B | 20k / 2026-02-27 | 40.46 (best fully open) | no — model must be served | unclear | scripts, self-hosted | high |
| MiroThinker 1.5/1.7 | 8.4k / 2026-07-06 | 69.8% BrowseComp (self) | agent model not on OpenRouter | no (Serper paid) | CLI via MiroFlow | high |
| local-deep-research | 9.1k / 2026-10-02 | none on Bench (SimpleQA ~95% self) | yes | SearXNG | web UI :5000; API unconfirmed | low-medium |
| deer-flow 2.0 | 83.3k / 2026-10-02 | none | yes (not confirmed in README) | DDG, SearXNG | interactive harness, not script-first | high |
| dzhng/deep-research | 19.7k / 2026-04-11 | none | yes | none (Firecrawl, unless self-hosted) | yes | medium |
| ms-agent (Agentic Insight) | 4.4k | ~55.31 claimed (secondary source) | unknown | unknown | WebUI/CLI | unknown |

## Shortlist to test

Ranked by expected report quality first, then setup effort.

1. **open_deep_research with a GPT-5-class backbone via OpenRouter.** Best
   measured quality of any open framework (49.33 vs Gemini's 49.71 — within
   reach of the reference). Deciding criteria: benchmark evidence and
   OpenRouter compatibility. Costs: framework archived (we run it read-only for
   a test, that is fine), and Tavily free tier (1,000 credits/month
   [guess: unverified this year]) or a paid search key is needed.
2. **gpt-researcher with `RETRIEVER=duckduckgo` or local SearXNG.** Most mature
   and the lowest setup cost; fully keyless is possible. Deciding criteria:
   keyless search + scriptability. Weakness: no benchmark evidence, so its
   expected quality is the lowest of the shortlist [guess].
3. **Tongyi DeepResearch 30B-A3B, self-served.** Best fully-open benchmark
   score (40.46). Deciding criterion: benchmark evidence. Weakness: highest
   effort — serve a 30B model on WSL2 and wire up an agentic search
   environment; I could not confirm a keyless search path from the README.
   Test only if the first two fall well short of Gemini.

Drop: MiroThinker (three external keys, model hosting), deer-flow 2.0 (wrong
tool shape), LDR (no report benchmark; keep as a backup because setup is
cheap), dzhng/deep-research (Firecrawl key blocker).

Suggested test protocol: run the same question through both tools on one
OpenRouter model for the writer role (same token budget), then compare against
the Gemini Deep Research report of the same question.

## Could not find out

- The DeepResearch Bench leaderboard CSV read through the reader has no rows
  for gpt-researcher, local-deep-research, MiroThinker, or deer-flow — report
  quality for those is unmeasured on this benchmark.
- The ms-agent "Agentic Insight v2" score of 55.31 comes from a websearch
  excerpt of the benchmark repo README; I did not read that page through the
  reader, and the CSV row I read has no matching entry under that name.
- Whether local-deep-research exposes an HTTP endpoint that a script can call
  for a report (its main surface is the web UI on :5000). The pip guide was
  not read.
- gpt-researcher's exact OpenRouter configuration (env var names for base URL)
  — the docs pages for LLM providers were not read.
- A keyless (SearXNG/DuckDuckGo) configuration path for Tongyi DeepResearch's
  local deployment — the README deployment section did not render in what I
  fetched.
- Whether Tavily's free tier is still 1,000 credits/month in 2026 — unverified.
- The file `docs/research/deep-research-eval/question-driver-layer.md` does not
  exist yet, so the test question is not fixed; the comparison protocol above
  assumes it will be created before the test runs.
