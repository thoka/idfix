---
checked: 2026-10-02
recheck: 1m
decisions:
  - "the agent-driven browser for our agents (candidate: agent-browser, fallback playwright-mcp)"
  - "whether to script the Gemini web app with HanaokaYuzu/Gemini-API (open: the user decides on the account risk)"
---

# API-driven browsers for agents, and the Gemini web app as an API

Read 2026-10-02. Every GitHub fact below comes from `gh api`, `gh search`, or a
`curl` of the README on `raw.githubusercontent.com`; ToS quotes come from the
page reader. Sources older than this date are marked. One X post naming seven
scraping tools suggested by the user is treated as a hint only; each tool is
judged on its own sources.

## Criteria

- Works for our agents: MCP server or CLI, callable from Claude Code and opencode.
- Self-hostable on our machine (WSL2, Docker available), or a clear hosted price.
- Logged-in sessions: persistent profiles, cookies survive restarts.
- Robustness against bot detection and against upstream UI changes.
- Maintenance effort for one user; maturity (stars, recent commits, archived).
- Cost: free self-hosted vs hosted per-hour or per-run.
- For Part 2 only: risk to the user's Google account, with evidence.

## Part 1, the landscape

How the search went (queries and relevant hits):

- `gh search repos "browser automation agent"` (by stars): mostly small repos; the big names came from a `playwright` query — 10 relevant hits.
- `gh search repos "gemini web api"`: 20 hits, most under 60 stars.
- `curl skills.sh/api/search?q=browser`: 20 hits, led by vercel-labs/agent-browser with 934,024 installs.
- `curl registry.modelcontextprotocol.io/v0/servers?search=browser`: several hits, led by browserbase MCP servers.
- `npm search "gemini web api"`: 3 relevant hits; `npm search "gemini-cli unofficial"`: 1 official plus noise.
- The seven tools from the user's X post: all seven found and checked.

### Layers and candidates

All repo facts below checked on 2026-10-02 with `gh api repos/<name>` (stars, pushed_at, archived, license) unless noted. GitHub API access was unauthenticated and hit its rate limit once mid-run; later repo facts come from README fetches only.

**Libraries and engines (you write the automation):**

| Project | Stars | Pushed | License | What it is |
|---|---|---|---|---|
| browser-use/browser-use | 116,990 | 2026-10-02 | MIT | Python/TS browser agent framework; cloud at $0.02/browser-hour with stealth, CAPTCHA solving, residential proxies |
| microsoft/playwright | 97,006 | — | Apache-2.0 | The base automation library under most of the rest |
| D4Vinci/Scrapling | 85,168 | 2026-09-30 | BSD-3 | Adaptive Python scraper, JS rendering, MCP server (README declares `mcp-name: io.github.D4Vinci/Scrapling`) |
| unclecode/crawl4ai | 84,637 | — | — | Crawler producing LLM-ready Markdown; self-host free, hosted cloud with MCP; v0.9.4 on 2026-09-23 |
| apify/crawlee | 25,966 | 2026-10-02 | Apache-2.0 | JS/TS crawler library; Playwright and Puppeteer under one interface, integrated proxy rotation and session management |
| ScrapeGraphAI/Scrapegraph-ai | 31,494 | 2026-09-25 | MIT | Python library: LLM builds scraping pipelines from a graph; [guess: heavy token cost per run, quality depends on the model] |
| projectdiscovery/katana | 17,609 | 2026-09-29 | MIT | Go CLI crawler for JS-heavy sites (headless mode, `-js-crawl`, known-files); security-recon tooling, no login-state workflows |
| adbar/trafilatura | 6,907 | 2026-10-02 | Apache-2.0 | Fetch, extract main text, metadata; fast rule-based, no JS rendering |
| medialab/minet | 375 | 2026-09-08 | GPL-3.0 | Web-mining CLI for long batch runs; mature (Zenodo 2025) but small and platform-focused (Twitter/Facebook/YouTube) |
| omkarcloud/botasaurus | 5,753 | 2026-07-26 | MIT | Python framework, claims to pass Cloudflare WAF and Fingerprint tests; README is marketing-heavy, no independent verification found |
| CloakHQ/CloakBrowser | 31,850 | 2026-09-29 | MIT | "Stealth Chromium that passes every bot detection test" — Chromium patched at C++ level, drop-in Playwright/Puppeteer replacement; free binary to try, "Pro" needs a license (price not on the README read) |
| lightpanda-io/browser | 35,732 | 2026-10-02 | AGPL-3.0 | Fast headless browser for AI agents; young engine, 100 open issues |

**Agent-ready browsers (CLI or MCP, what our agents call directly):**

| Project | Stars | Pushed | License | Interface | Logged-in sessions |
|---|---|---|---|---|---|
| vercel-labs/agent-browser | 43,450 | 2026-10-01 | Apache-2.0 | Rust CLI (`open`, `snapshot`, `click @e2`, `read`), MCP profile, 934k installs on skills.sh | `--profile <path>` persistent profile (cookies, IndexedDB, service workers); cookies get/set/import; encrypted credential vault (`auth login`); stealth via a plugin |
| microsoft/playwright-mcp | 37,760 | 2026-09-28 | Apache-2.0 | MCP (`npx @playwright/mcp`), accessibility snapshots | Persistent profile by default (`--user-data-dir`), `--storage-state`, one browser per profile (concurrent clients conflict) |

agent-browser is the standout from skills.sh: 934,024 installs, active daily, both CLI and MCP, persistent profiles, a credential vault where the LLM never sees passwords, and a `read` command that fetches a URL without launching Chrome and falls back through Markdown / `llms.txt` / readable text. That last feature directly replaces part of what the `reader` subagent does through webfetch today.

**Hosted browser services:** browser-use cloud ($0.02 per browser-hour per its README), Browserbase (MCP servers in the official registry; price not checked), Crawl4AI cloud (first $10 free until 2026-12-31). None needed now — our agents run on a machine that can host a browser locally.

**Self-hostable browser services:** steel-dev/steel-browser (7,725 stars, Apache-2.0, pushed 2026-09-28) — a Docker browser API with sessions; browserless (Docker headless browsers, cloud or self-host). Both add a REST layer over Playwright; we would only need them if sandbox isolation requires the browser to run in a separate container.

**Crawl/Markdown tools:** crawl4ai and Scrapling cover page-to-Markdown; `agent-browser read <url>` covers it without a server; trafilatura covers clean text extraction without JS.

Known failure modes found in issues: browser-use has 534 open issues (volume typical for its size); playwright-mcp profiles conflict across concurrent clients (README, "A persistent profile can only be used by one browser instance at a time"); CloakBrowser and botasaurus have no independent verification of their stealth claims — the READMEs are their own evidence; CloakBrowser's Pro tier gating means the "free" part may change [guess].

## Part 2, the Gemini web app as an API

### What the terms say

Reader, read 2026-10-02. The Google Terms of Service (https://policies.google.com/terms, effective 2026-07-30), section "What we expect from you" → "Don't abuse our services":

> "You must not abuse, harm, interfere with, or disrupt our services or systems"

with bullets including

> "using automated means to access content from any of our services in violation of the machine-readable instructions on our web pages (for example, robots.txt files that disallow crawling, training, or other activities)"

and

> "reverse engineering our services or underlying technology, such as our machine learning models, to extract trade secrets or other proprietary information, except as allowed by applicable law"

The Generative AI Prohibited Use Policy (https://policies.google.com/terms/generative-ai/use-policy, last modified 2024-12-17), item 2:

> "Abuse of, harm to, interference with, or disruption to Google's or others' infrastructure or services. ... Circumvention of abuse protections or safety filters"

So driving gemini.google.com from a script is a contract breach, not a crime: the CFAA analysis (cloro.dev blog, read 2026-10-02) is that the line "sits at the Google login" and that ToS risk is contractual, binding hardest on logged-in use. The terms apply to the account that logs in.

Enforcement (https://support.google.com/gemini/answer/16625148, read 2026-10-02): "We use a combination of automated systems and human review to detect activity and behavior that suggest misuse" and "Repeated violations of the Prohibited Use Policy may lead to restrictions to your Generative AI product usage and/or your Google account." Google commits to in-product/email notifications and an appeal path before escalation language, but the policy text itself does not promise notice.

### Existing projects

- **HanaokaYuzu/Gemini-API** (3552 stars, pushed 2026-08-27, AGPL-3.0, `gemini_webapi` on PyPI): reverse-engineered async Python wrapper for the web app. Auth is two cookies from the logged-in browser (`__Secure-1PSID`, `__Secure-1PSIDTS`), auto-refreshed and persisted (a `GEMINI_COOKIE_PATH` for containers). It explicitly supports **Deep Research**: plan turn, confirm turn, server-side detached run, report as an inline document with `[cite: N]` markers and a source list; `doc.markdown` writes a full report; reports take 5–10 minutes. It has a CLI. Issue #359 (open, 2026-09-19): `create_deep_research_plan()` got a model refusal on 2.1.1 while the web UI worked. Issue #330: interface update degraded output quality until the library caught up. Issue #323: Google started recognizing `curl_cffi` TLS fingerprints (JA3/JA4) and returned 429 on all `/app` requests; same cookies worked in a real Chrome; the fix is routing through a real browser. Issue #313: requests "silently aborted by Google". No issue in the repo's recent list reports an account warning, restriction, or ban.
- **XxxXTeam/geminiweb2api** (56 stars, OpenAI-compatible proxy, updated 2026-09-20) and a dozen smaller forks/proxies found by `gh search repos "gemini web api"` (5–16 stars each) and `npm search "gemini web api"` (`@8-/gemini-web-api`, `n8n-nodes-gemini-web-api`). All are cookie- or reverse-engineering based; none is large or independent of the same breakage class.
- **@google/gemini-cli** (npm, Apache-2.0, 0.62.0 on 2026-09-29) is official but calls the Gemini API, not the web app, so it is not Deep Research on the user's Google One plan.
- skills.sh has no established gemini-deep-research skill (largest: 74 installs).

Deep Research support: yes, only Gemini-API (and its direct clones) does, through the web app's own deep research flow.

### Risk to the account, with evidence

- Contract breach is clear (ToS quotes above). Reverse-engineering a Google service is also named in the ToS.
- Technical detection is real and current: issue #323 (read 2026-10-02) shows Google blocking `curl_cffi` TLS fingerprints with 429s as of 2026. Traffic from a real browser instance still passed.
- Found evidence for account damage: **none**. No ban or warning report in Gemini-API's issue list (checked 2026-10-02 via `gh api` issues and `gh search issues`), none in the issue the reader read, none found by `gh search issues "gemini web api banned account"` (0 hits). Enforcement that Google documents is about GenAI misuse (content policy), reached through notifications, restrictions, and appeals.
- Residual risk [judgment, not fact]: Google can restrict "your Google account" per its enforcement page, and the account used is the user's Google One account. Low volume, human-paced, Deep-Research-shaped usage from the user's own session cookies has no documented ban cases, but absence of evidence is not evidence of safety. Mitigation if the user wants it: run it on a separate Google account, not the main one.

## Part 3, criteria and options

| Option | Agent call | Self-host | Logged-in sessions | Robustness | Maintenance for one user | Cost | Account risk |
|---|---|---|---|---|---|---|---|
| agent-browser (CLI/MCP) | CLI + MCP, skills.sh 934k installs | yes, local Chrome | persistent profile, cookie import, credential vault | active daily; click-fail-early; `read` fallback chain | low; single binary + Chrome for Testing | free | none (general browsing) |
| playwright-mcp (MCP) | MCP, npx | yes | persistent profile by default | Microsoft-maintained, 37.8k stars | low | free | none |
| browser-use (library/agent) | Python library + cloud | yes | supported (framework) | 117k stars, very active | medium (writes Python per site) | free / $0.02 per browser-hour | none |
| crawlee | library | yes | session management built in | active, Apify-backed | medium (JS/TS code) | free | none |
| crawl4ai / Scrapling / trafilatura | Python lib, some MCP | yes | crawl4ai yes | active | low–medium | free | none |
| katana | CLI | yes (Docker) | no login-state workflows | active | low | free | none |
| steel-browser / browserless | REST in Docker | yes | session persistence | active | medium (one more service) | free | none |
| CloakBrowser / botasaurus | Python/JS libs | yes | yes | unverifiable claims | unknown | free tier + Pro license [unknown price] | none |
| Gemini-API (gemini.google.com) | Python lib + CLI | yes | cookies from real browser, auto-refresh | breakage class proven: 429 TLS detection, UI changes, deep-research refusals (#323, #359, #330) | low–medium; breaks when Google changes the web app | free (uses Google One plan) | contract breach, no documented ban cases, Google can restrict the account |
| geminiweb2api & clones | OpenAI-compatible proxy | yes | cookies | same class, fewer eyes | higher (small projects) | free | same as Gemini-API |

### Options for us

1. **agent-browser as the everyday agent browser.** One CLI covers static pages (`read <url>` without Chrome), JS pages (snapshot/click), logged-in apps (persistent profile, cookie import, credential vault), and an MCP mode for Claude Code and opencode. 934k installs on skills.sh and daily commits decide the maintenance and robustness criteria. Cost: zero. This replaces the `reader` subagent's webfetch for hard pages while webfetch/Exa stay for easy ones.
2. **playwright-mcp as the fallback if a page defeats agent-browser.** Same profile model, Microsoft maintenance, pure MCP. Keep both installed; they cost nothing.
3. **Gemini-API for Gemini Deep Research.** The only project with a working Deep Research workflow (plan, confirm, poll, Markdown report with cited sources), which is exactly the user's use case. Deciding criteria: it is the only option that reaches Deep Research at all, and the risk criterion is satisfied only if the user accepts a contract breach on their own account with no documented ban cases. Recommended safeguards [judgment]: low volume, run from real-browser cookies, consider a separate Google account, and treat breakage (#323-style 429s, #359-style refusals) as expected and recoverable.
4. Keep crawl4ai/trafilatura on the radar for bulk crawling; katana for link discovery. Do not adopt CloakBrowser or botasaurus without an independent test on our targets; do not adopt browser-use's agent framework unless a site needs model-driven exploration — our agents already supply the model.

## Could not find out

- The X post could not be read through the reader; the user pasted its content instead, and the seven tools were checked individually.
- CloakBrowser Pro pricing and license terms; whether the free binary stays free.
- Any documented case of a Google account restriction caused by Gemini web-app automation (searched, none found — this is absence of evidence, not proof of safety).
- Browserbase pricing (registry entry read only).
- Whether geminiweb2api supports Deep Research (README not read; Gemini-API does, verified).
- Independent benchmark of bot-detection claims for CloakBrowser and botasaurus.
