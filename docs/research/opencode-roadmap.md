---
checked: 2026-09-30
recheck: on new opencode release
decisions:
  - "stay on opencode 1.18.32"
---

# The state of opencode development and the road to 2.0

Written 2026-09-30 for the `oc-sub` project, which pins opencode **1.18.32** (`mise.toml:3`). Builds on [openrouter-routing.md](openrouter-routing.md) (model suffixes, issue #48016), [real-cost.md](real-cost.md) (issue #43818, `usage.cost`), and [sse-client.md](sse-client.md) (the unhandled AbortError in the generated SDK client).

## Criteria

Used for the recommendation in §5:

1. Fixes that we need — does a version fix #48016, #43818, or the SDK SSE abort bug?
2. Risk of regressions — how fast does opencode move, and what breaks between versions?
3. Effort of the update — work for `oc-sub` to absorb a version change.
4. Longevity — does the version have a future, or is it about to be replaced?

## 1. Latest release and what changed since 1.18.32

**Latest stable release: v1.18.33, published 2026-09-28** ([releases](https://github.com/anomalyco/opencode/releases)). The GitHub "Latest" marker is on v1.18.33; nothing above 1.18.x is published as a release on the default channel.

### Changes 1.18.32 → 1.18.33

30 commits between the tags (GitHub compare API, 2026-09-30). The release notes ([v1.18.33](https://github.com/anomalyco/opencode/releases/tag/v1.18.33)) list only fixes:

- Cloudflare AI Gateway models now honor provider response and stream timeouts (@danlapid, #51549).
- MCP browser launch failures are reported when the launcher exits immediately.
- Debug configuration output redacts credentials and sensitive headers.
- Gemini thinking defaults and effort options match supported controls (@markmcd, #50841).

**None of the changes matter for `oc-sub`.** Specifically, on our three known issues:

| Issue | Status on 2026-09-30 |
|---|---|
| Model suffixes `:floor`/`:nitro`/presets not resolvable (#48016) | **still open**, fix PR #48117 still open and unmerged ([issue](https://github.com/anomalyco/opencode/issues/48016)) |
| Honor provider-reported cost `usage.cost` (#43818) | **still open**, no update since 2026-08-21 ([issue](https://github.com/anomalyco/opencode/issues/43818)) |
| Unhandled AbortError from SSE `reader.cancel()` in the generated SDK client | **not fixed**: the `serverSentEvents.gen.js` in SDK 1.18.33 is byte-identical to 1.18.32 (verified by tarball diff in [sse-client.md](sse-client.md) §1). The related provider-side issue #44943 was closed 2026-09-02 via merged PR #44944 ("handle SSE reader cancel rejections"), but that fixes opencode's own provider stream, not the SDK client that `oc-sub` calls |

### 2.0 is not on the stable release channel

A separate v2 exists and ships through its own channel: docs at [opencode.ai/v2/docs](https://opencode.ai/v2/docs) (install: `brew install anomalyco/tap/opencode-v2`, `paru -S opencode-beta`, install script at `opencode.ai/v2/install`). The docs reference binaries at `opencode.ai/files/bin/2.0.6/...`; the GitHub tag list contains **v2.0.1 through v2.0.20** (tags API, 2026-09-30; the v2 tags carry no release notes on the releases page). No date for the v2 tags could be confirmed (GitHub API rate limit hit during the check — open question).

## 2. Is a 2.0 release planned?

**Yes, it exists as a public beta-like channel, but it is not declared stable and no launch date is published.** Sources:

- Reddit announcement "OpenCode v2.0 now in beta", 2026-07-30 ([r/opencodeCLI](https://www.reddit.com/r/opencodeCLI/comments/1uvpgxr/opencode_v20_now_in_beta/)). A commenter: "As their docs say in https://v2.opencode.ai/ it's experimental and may change things that might affect your work so just be aware of it."
- The internal plan is candid about the state, in `specs/v2/todo.md` ([blob at 77429f59](https://github.com/anomalyco/opencode/blob/77429f59/specs/v2/todo.md)): "ok we need to work towards a launch of v2 so we can get out of this rebuild phase".
- The v2 docs themselves carry **no stability statement and no date** ([opencode.ai/v2/docs](https://opencode.ai/v2/docs)). The only "beta" labeling found is the AUR package name `opencode-beta`.
- There is a `2.0` git branch, but it is stale: last commit 2026-04-13, 0 commits ahead of v1.18.33 and 4,684 behind (branch/compare API, 2026-09-30). Active v2 work lives on the `v2` branch/tree instead ([opencode.ai/changelog](https://opencode.ai/changelog) header link). Issues prefixed "2.0:" (e.g. [#36441](https://github.com/anomalyco/opencode/issues/36441), [#36444](https://github.com/anomalyco/opencode/issues/36444), [#51135](https://github.com/anomalyco/opencode/issues/51135), all open) carry the `2.0` label and confirm ongoing v2 hardening.

**No date is known.** No source gives a stable-2.0 date.

## 3. What 2.0 would break for us

Quotes from `specs/v2/todo.md` ([blob](https://github.com/anomalyco/opencode/blob/77429f59/specs/v2/todo.md)) and the v2 docs:

| Area | What changes | Effect on `oc-sub` |
|---|---|---|
| Server API | "The opencode server has moved to the Effect HttpApi backend" (todo). Hono is removed; "EventV2 ... without relying on the old bus system". Event scoping is redesigned ("2.0: Scope event subscriptions by client interest", #36443) | High. `oc-sub` consumes `GET /global/event` SSE and REST endpoints of the 1.x API; the event shapes and scoping change |
| SDK | The v2 SDK is regenerated (`packages/sdk/js/src/v2/...`); 1.x SDK generation is separate | The `@opencode-ai/sdk` API surface we code against changes; our SSE workaround has to be re-evaluated against the v2 generated client |
| Config format | "We should do another pass on config ... Old configs should get auto-converted to new" (todo) | Medium. Auto-conversion is promised but our provider `options`/`extraBody` routing config (openrouter-routing.md §2) is untested in v2 |
| Agent files | No agent (markdown) format change mentioned in the todo or docs | Unknown / probably low, but unverified |
| Plugin API | "We need to figure out how we want server plugins to work and what hooks are useful" (todo). "Providers should register as plugins and autoload" (todo). The Reddit thread: "These will likely break existing plugins" | High for anything plugin-based; today `oc-sub` uses no plugin, so low direct impact |
| Cost (`usage.cost`) | No mention of honoring provider-reported cost in the v2 plan | Issue #43818 unresolved in v2 planning as far as any public source shows |

v1 also prepares for coexistence: v1.18.24 (2026-08-28) added "V1 now reads supported V2 config fields so newer config files keep working in more mixed setups", and v1.18.19 "Preserved compatibility with existing v1 databases" ([opencode.ai/changelog](https://opencode.ai/changelog)).

## 4. Release speed and stability (1.x)

- **8 stable releases in the last 30 days** (2026-08-31 → 2026-09-30: v1.18.26 … v1.18.33, roughly two per week; releases API, 2026-09-30).
- The release notes for v1.18.26–v1.18.33 contain no explicit revert or hotfix notices (grep of release bodies, 2026-09-30). The cadence is steady patching rather than emergency fixes; same-day pairs (v1.18.28/29 on 2026-09-04) show bugs being turned around within a day or two.
- 6,327 open issues, repo pushed 2026-09-30, not archived (repo API, 2026-09-30). A high-velocity project; regressions do get filed fast (e.g. v2 regressions #52028, #51852), so any version bump should be deliberate, not automatic.

## 5. Recommendation for `oc-sub`

Judged against the criteria:

| Option | Fixes we need | Regression risk | Effort | Longevity |
|---|---|---|---|---|
| Stay on 1.18.32 | None of our three issues is fixed in 1.18.33 anyway (§1) | Zero (pinned, tested) | None | 1.x still gets releases; coexistence with v2 is being maintained |
| Move to latest 1.x (1.18.33) | None (nothing relevant changed) | Low but nonzero: 30 commits, 8 releases/month cadence; our repro shows the SDK SSE bug is *not* fixed in 1.18.33 | Small (bump `mise.toml`, re-run tests) | Same as 1.18.32 |
| Wait for / move to 2.0 | Not addressed: #48016 and #43818 have no v2 fix, plugin API still in design (§3) | High: Effect HttpApi server, EventV2, regenerated SDK, config pass (§3); AUR/docs call it beta | Large: rework SSE consumption and REST calls against the v2 API | Unclear launch date |

**Recommendation: stay on 1.18.32 for now.** The deciding criteria are "fixes that we need" (1.18.33 fixes none of our three issues; the SSE abort bug survives verbatim into the 1.18.33 SDK) and "effort" (a bump to 1.18.33 buys nothing measurable). Our SSE plan (own `fetch` + `eventsource-parser` loop, [sse-client.md](sse-client.md) §4) is version-independent and should land regardless.

Process: check the release notes roughly monthly; bump the pin only when a release fixes one of #48016, #43818, or the SDK SSE abort handler. Re-evaluate 2.0 only after a declared stable v2 launch plus the release of a migration guide — today none exists, and the "rebuild phase" quote (§2) says the maintainers themselves do not consider it launched.

## Open questions

1. Dates of the v2.0.x tags (v2.0.0 … v2.0.20): GitHub API rate limit prevented confirmation; the docs reference only 2.0.6.
2. Does v2 fix the model-suffix resolution (#48016) or honor `usage.cost` (#43818)? No public source found either way.
3. Was the Reddit claim "docs say it's experimental" ever an official statement on v2.opencode.ai? The current docs page carries no such sentence; possibly removed or on Discord (not public-readable).
4. Does the v2 generated SDK client still ship the un-caught `reader.cancel()` abort handler? (The 1.x one does; the v2 gen at `packages/sdk/js/src/v2/gen/core/serverSentEvents.gen.ts:141` still had it on `main`, per [sse-client.md](sse-client.md) §2, checked 2026-09-30.)

## Search log

- GitHub API `repos/anomalyco/opencode/releases`, `branches`, `tags`, `compare`, `milestones`, issues/pulls 48016, 48117, 43818, 44943, 44944, 44912 — all facts in §1–§4.
- `gh search issues --repo anomalyco/opencode "2.0"` — 15 hits, ~8 relevant (the "2.0:"-prefixed label series).
- websearch "opencode 2.0 release roadmap announcement anomalyco/sst opencode" — 8 results, 4 relevant (Reddit beta post, specs/v2/todo.md, v2 docs, changelog).
- reader on opencode.ai/v2/docs and specs/v2/todo.md — quoted in §2–§3. reader on opencode.ai/changelog — v1 entries quoted in §3; no 2.0.x entries.
- Rate-limited: dates of v2 tags. Not tried: Discord (not public-readable).

## Review of the main thread (2026-09-30)

Accepted. oc-sub stays on 1.18.32. The proxy of step 11 does not depend on the plugin API or on the event format, so a later move to 2.0 does not affect it. The main thread checks the release notes once a month for #48016, #43818, and the SSE abort handler.
