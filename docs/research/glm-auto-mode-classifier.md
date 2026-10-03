---
checked: 2026-10-03
recheck: 1m
decisions:
  - "the classifier names the session model in the error, so on GLM the classifier call goes to z-ai/glm-5.3-flash through OpenRouter (fallback to session model)"
  - "classifier timeout is not configurable and API_TIMEOUT_MS does not apply to it; fixes are narrow allow rules or turning auto mode off"
  - "narrow allow rules skip the classifier in auto mode; add Bash and SendMessage rules for the recurring commands"
  - "OpenRouter per-request provider routing (provider.sort latency) is documented, but Claude Code will not send it; only the OpenRouter account-level default could apply"
---

# GLM auto mode classifier timeouts

Read 2026-10-03. Sources: Claude Code docs on code.claude.com, the Claude Code
CHANGELOG, GitHub issues of anthropics/claude-code, and the OpenRouter docs
and model page. Facts only; guesses are marked.

## 1. Which model does the classifier use?

The docs never name a fixed model. The permission-modes page calls it "a second
model, the classifier" (https://code.claude.com/docs/en/permission-modes).

- The default client-side classifier is Claude Sonnet 5. Changelog 2.1.288:
  "Changed the client-side auto mode classifier to ignore an
  `ANTHROPIC_DEFAULT_SONNET_MODEL` pin that names Claude Sonnet 5.5 or Opus 5.5
  and use Claude Sonnet 5 instead" (CHANGELOG.md in anthropics/claude-code).
- On the Anthropic API the classifier can also run server-side, at no charge
  (billing doc, see question 6). Through a gateway the server-side check does
  not reach Claude Code, so it makes its own client-side classifier requests.
- The classifier falls back to the session model when its dedicated model is
  unavailable: issue #96649 — "The classifier normally uses a dedicated model
  (Sonnet 5), but falls back to the session model when that's unavailable"
  (https://github.com/anthropics/claude-code/issues/96649). Also #74949: the
  error text names the session model in many reports.
- In our session the error named `z-ai/glm-5.3-flash`. So the request that
  timed out went to the session model through OpenRouter — either as the
  fallback classifier, or because with a non-Claude session model no Sonnet
  model exists at the gateway. The docs do not state which (guess, marked).

Can a setting choose the classifier model? Partially, undocumented:
issue #91410 — "the `CLAUDE_CODE_AUTO_MODE_*` env vars expose the model,
temperature, retry counts, etc., but no timeout"
(https://github.com/anthropics/claude-code/issues/91410). Issue #81142 reports
that `CLAUDE_CODE_AUTO_MODE_MODEL` "does not govern the failing request"
(https://github.com/anthropics/claude-code/issues/81142). No documented
setting exists; the docs list only `CLAUDE_CODE_AUTO_MODE_SERVER=0/1` and
`permissions.disableAutoMode` (permission-modes page).

## 2. What is the timeout of a classifier request?

- 30 s per attempt, fail-closed: issue #64533 — "Auto mode classifier
  unavailable, denying with retry guidance" after a "30s timeout"
  (https://github.com/anthropics/claude-code/issues/64533).
- Larger budgets observed in the binary, v2.1.258, issue #91410: "60 s base,
  scaled up with context size, ~120 s cap per stage, up to ~5 min including
  retries"; fast stage deadline "min(120 s, 60 s + 10 s per 50k tokens above
  50k)". These two issues disagree on the number; both agree it fails closed.
- Not configurable. Issue #91410 is an open feature request to expose it.
- `API_TIMEOUT_MS`: no source found that it applies to the classifier
  request. For main-loop requests, #70008 reports it was "ineffective" for a
  ~60 s ceiling (https://github.com/anthropics/claude-code/issues/70008).
- Server-side review variant: repeated attempts slow down and stop the turn
  after 10 no-verdict responses in a row (#97855,
  https://github.com/anthropics/claude-code/issues/97855).

## 3. Do allow rules skip the classifier in auto mode?

Yes, narrow rules do. auto-mode-config doc
(https://code.claude.com/docs/en/auto-mode-config):

> "By default, narrow Bash and PowerShell allow rules such as `Bash(npm test)`
> stay in effect in auto mode. Claude Code resolves them before the classifier
> runs... Claude Code suspends only the broad rules that grant arbitrary code
> execution, such as `Bash(*)` or wildcarded interpreters."

So `Bash(git commit *)` skips the classifier. `SendMessage` and other tools
can get allow rules too; deny and explicit ask rules run before the classifier
and still block or prompt. Broad rules can be forced through the classifier
with `autoMode.classifyAllShell: true`. Known failure mode (#74949
comment): read-only-looking commands like `git -C /path status` do not match
narrow rules and still hit the classifier.

## 4. What happens on a classifier timeout?

Fail-closed block, no retry beyond the built-in attempts, no fallback to a
prompt. Docs (https://code.claude.com/docs/en/permission-modes):

> "The server gives no verdict for an action: Claude Code denies the action
> rather than run it unreviewed."

Errors page (https://code.claude.com/docs/en/errors): the "temporarily
unavailable" message "means a classifier request failed. That failure is
usually transient". Issue #74949 confirms "the design is fail-closed with no
fallback to a manual permission prompt"
(https://github.com/anthropics/claude-code/issues/74949). A fallback-to-prompt
is an open feature request (#74949, #86339), not shipped. Changelog 2.1.288
adds context compaction instead of "prompting for, or failing, every tool
call" when the conversation is too long, but no timeout fallback.

## 5. Reasoning setting and OpenRouter providers

Does the classifier send a thinking/reasoning setting? No source found. The
error text and issues do not say; #86339 mentions Stage 2 is "a short
chain-of-thought", which suggests the classifier does think, but the request
payload is not documented (guess, marked).

OpenRouter (https://openrouter.ai/docs/features/provider-routing and the model
page https://openrouter.ai/z-ai/glm-5.3-flash, read 2026-10-03):

- Per request you can turn reasoning off: "reasoning: {enabled:false}" maps to
  Anthropic "thinking: { type: 'disabled' }", or `"effort": "none"` —
  "Disables reasoning entirely". `"exclude": true` only hides the output, the
  tokens are still billed.
- Per request you can sort providers: "`sort` | string | object | Sort
  providers by price, throughput, or latency", e.g. `provider: {sort:
  "latency"}`. Also `only`/`ignore`/`order` provider lists.
- Caveat for our use: Claude Code, not our code, sends the classifier request,
  so it will not carry a `provider` block. Only account-level routing defaults
  could apply, and the docs show account-level controls only for
  data-policy providers, not latency sorting.
- Providers serving the model (about 30) with p50 latency / throughput at read
  time: Friendli 370 ms / 112 tok/s, Modal 432 / 81, BaseTen 468 / 140,
  Parasail 821 / 97.5, CoreWeave 825 / 90, Crusoe 1476 / 93, Cloudflare 1454 /
  71, Z.AI 2904 / 46, DeepInfra 2785 / 21, Phala 4752 / 49. OpenRouter
  balances across them by default, so a classifier request can land on a slow
  provider (p99 latencies run 5–27 s).

## 6. The billing doc through a gateway

Source: https://code.claude.com/docs/en/auto-mode-classifier-billing (read
2026-10-03).

- With server-side checks on, "the server performs those checks as part of the
  session's own model requests, at no charge".
- "The most common cause is an LLM gateway or proxy between Claude Code and
  the API" — the gateway strips headers or fields, so the server's checks
  never reach Claude Code. Claude Code then makes its own classifier requests,
  "billed as token usage".
- It offers `CLAUDE_CODE_AUTO_MODE_SERVER=0` to stop asking for server-side
  checks when the gateway cannot pass them through ("Classifier requests are
  then always Claude Code's own, billed the same way").
- The gateway must forward request fields it does not recognize, "such as the
  `safeguards` request field", and return "the `safeguard_results` field"
  unchanged. OpenRouter will not do this for an Anthropic-format endpoint, so
  our setup is the client-side classifier, billed as token usage on OpenRouter.

## Options

1. **Add narrow allow rules** for the recurring Bash commands and SendMessage
   to `permissions.allow`. Narrow rules resolve before the classifier, so the
   failing calls vanish. Source: auto-mode-config doc. Cheap, but only covers
   known command shapes.
2. **Stop using `--permission-mode auto` on GLM sessions.** Use
   `acceptEdits` or `bypassPermissions` in the trusted worktree. Removes the
   classifier entirely; loses the safety layer. Source: permission-modes doc.
3. **Set `CLAUDE_CODE_AUTO_MODE_SERVER=0`.** Only stops the server-side
   attempt; the client-side classifier still runs and still times out through
   OpenRouter. Source: billing doc. Does not fix our case.
4. **Try `CLAUDE_CODE_AUTO_MODE_MODEL`.** Undocumented, and #81142 reports it
   does not govern the failing request. Low odds; test only.
5. **OpenRouter account-level provider preference.** No documented
   account-wide latency sort; per-request `provider.sort` cannot be injected
   because Claude Code owns the request. Not actionable.
6. **Wait for an upstream fix.** Timeout configurability is an open feature
   request (#91410); fallback-to-prompt is open (#74949). No knob today.
