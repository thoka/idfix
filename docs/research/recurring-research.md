# Recurring research: how others keep facts and decisions fresh

Date: 2026-10-01. Read date for all quotes: 2026-10-01.

The problem: each report in `docs/research/` records facts with a date, but no field says when the facts go stale or which decision rests on them. This report answers three questions: (1) how do others record review times, (2) which metadata format is common in Markdown reports, (3) how can a scheduled job run on this machine when the user is away.

## 1. Criteria

From the brief and the global rules:

- Cost per month is near zero (machine time, no repeated paid runs).
- No repeated work: an expensive check runs once and its result is cached.
- The result reaches `docs/PLAN.md` of the project (a line in the open tasks, as PLAN.md does today).
- The same setup works for all projects in `~/dv`, not just this one.
- Runs when the user is away (the user is often not at the machine).
- Simple to maintain; no new service to babysit.
- Paid runs need a cap and a decision of the user before they run unattended (PLAN.md step 17d).

## 2. Question 1: how do others record that a fact needs review?

### ADRs (architecture decision records)

- Nygard-style ADRs are immutable: "Don't alter existing information in an ADR. Instead, amend the ADR by adding new information, or supersede the ADR by creating a new ADR." The same repo says "It's typical for teams to review each ADR one month later, to compare the ADR information with what's happened in actual practice", and recommends "maintenance, periodic review at least once per year, and eventual sunsetting". Sources: https://github.com/architecture-decision-record/architecture-decision-record (read 2026-10-01). The template carries a timestamp for when it was written, not a review date.
- MADR has optional front matter `status` ("proposed | rejected | accepted | deprecated | … | superseded by ADR-0123") and `date` ("YYYY-MM-DD when the decision was last updated"). The body says "define when/how this decision should be realized and if/when it should be re-visited", and has an optional "Confirmation" section. Source: https://github.com/adr/madr/blob/main/template/adr-template.md (read 2026-10-01). So MADR puts the re-visit advice in the text, not in a machine-readable field.

Takeaway: ADR practice uses a status + last-updated date, plus a human convention to revisit. Nobody machine-checks it; that gap is what our `doctor` check 17c fills.

### Technology radars

- Thoughtworks: "Thoughtworks Technology Radar is a twice-yearly snapshot" (Volume 34, April 2026). Rings Adopt/Trial/Assess/Caution, movement flags "New / Moved in/out / No change". Freshness is per volume, not per blip. Source: https://www.thoughtworks.com/radar (read 2026-10-01).
- Zalando: rings ADOPT/TRIAL/ASSESS/HOLD; "Assignment of technologies to rings is the outcome of ring change proposals, which are discussed and voted on." Again no per-item review date. Source: https://opensource.zalando.com/tech-radar/ (read 2026-10-01).

Takeaway: a radar refreshes on a fixed cadence and writes the change ("no change" is also recorded). Our step 17d "Recheck <date>" section with only changes copies this.

### Renovate and Dependabot

- Renovate supports a `schedule` in cron syntax (recommended; the old `@breejs/later` text syntax is deprecated), for example `* * 1 */3 *` for "every 3 months on the first day of the month". Granularity is at least one hour, default timezone UTC. Renovate runs when its administrator runs it ("usually hourly" for the Mend app); the schedule only gates whether it looks for updates. Sources: https://docs.renovatebot.com/configuration-options/ and https://raw.githubusercontent.com/renovatebot/renovate/main/docs/usage/key-concepts/scheduling.md (both read 2026-10-01).
- Dependabot: `schedule.interval` is one of "daily, weekly, monthly, quarterly, semiannually, yearly, or cron", with `schedule.time` and `schedule.timezone`. There is also a default `cooldown` of 3 days between version updates. Source: https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/configuration-options-for-the-dependabot.yml-file (read 2026-10-01).

Takeaway: the dependency tools name intervals as English words (monthly, quarterly) rather than raw dates. PLAN.md's first guess (interval per topic) matches this. Both tools are push-based: the schedule triggers the check, the result reaches the user as a PR or issue.

### Documentation freshness

- Microsoft Learn requires `ms.date` in front matter: "Displayed on the published page to indicate the last time the article was substantially edited or guaranteed fresh", with build-time validation ("If you omit any of these, you'll likely get a validation error during build"). Source: https://learn.microsoft.com/en-us/contribute/metadata (read 2026-10-01).
- Antora auto-assigns read-only page attributes from git (edit URL, ref hash); the "last updated" display comes from the default UI. Source: https://docs.antora.org/antora/latest/page/intrinsic-attributes/ (read 2026-10-01).
- GitHub documents no freshness field; wikis rely on git history (https://docs.github.com/en/communities/documenting-your-project-with-wikis, read 2026-10-01).
- Dedicated freshness tools exist, all with front matter or git-history based checks:
  - `andimrob/docrot`: front matter under a `docrot:` key with `last_reviewed`, `strategy: interval | until_date | code_changes`, `interval: 90d` or `expires: "2024-06-01"`; commands `docrot check` (exit 1 when stale), `docrot review <file>` (writes today's date), `docrot init`. Source: https://github.com/andimrob/docrot (read 2026-10-01). Repo maturity: unknown stars, first release recent — treat as immature, use as a design reference only.
  - `giantswarm/frontmatter-validator` (Go): checks `NO_LAST_REVIEW_DATE`, `REVIEW_TOO_LONG_AGO`, `INVALID_LAST_REVIEW_DATE` in YAML front matter. Source: https://github.com/giantswarm/frontmatter-validator (read 2026-10-01). Immature (small tool, but it names the same fields).
  - `joaquimscosta/docs-health-action` and `EvangeLabs/content-freshness-gate`: staleness from git history instead of a field, and they open issues for stale docs. Sources: https://github.com/joaquimscosta/docs-health-action, https://github.com/EvangeLabs/content-freshness-gate (both read 2026-10-01). Both immature.
  - GitHub Agentic Workflows uses an `expires: "YYYY-MM-DD"` field for suppressions that must come back into force. Source: https://github.github.com/gh-aw/reference/frontmatter/ (read 2026-10-01). This is a precedent for a "until date, then check again" trigger.

Takeaway: two competing patterns. A `last_reviewed` + `interval` field (docrot, Microsoft, giantswarm) is the common one; git-history staleness (docs-health-action, content-freshness-gate) does not fit us, because a report that gets a "Recheck: no change" section would look fresh while its facts are not. Trigger-based rechecks (Renovate release hooks, gh-aw `expires`) cover the release-dependent topics.

## 3. Question 2: which metadata head format is common?

YAML front matter between `---` lines is the universal format. Real field names collected:

| Source | Field names |
| --- | --- |
| MADR | `status`, `date`, `decision-makers`, `consulted`, `informed` |
| Microsoft Learn | `ms.date`, `ms.author`, `ms.topic`, `title`, `description` |
| docrot | `docrot.last_reviewed`, `docrot.strategy`, `docrot.interval`, `docrot.expires` |
| giantswarm frontmatter-validator | `last-review-date` (check names `NO_LAST_REVIEW_DATE`, `REVIEW_TOO_LONG_AGO`) |
| gh-doccy | `metadata.lastUpdated`, `metadata.staleness` |
| docs-health-action | `last_updated` |
| GitHub Agentic Workflows | `expires` |

The names that repeat are a review date (`date` / `ms.date` / `last_reviewed` / `lastUpdated`) and an interval or expiry (`interval` / `expires` / `staleness`). No source I found combines an interval with a decision link in one field. The plan's step 17b head (`recheck` + `decisions`) is compatible: `recheck` as the interval, date, or trigger; `decisions` as the list of plan items. I found no prior art for the `decisions` field; that part is a genuine extension, not copied.

An existing convention to reuse: the research index (`bin/research-index.py`, meta) already lists reports; the recheck fields go there as a due-list, the same role that Renovate's schedule + dashboards play.

## 4. Question 3: how does a scheduled job run when the user is away?

Key background fact: WSL2 shuts the whole VM down seconds after the last process that is a child of Microsoft's `init` ends. systemd services do not keep it alive: "systemd services won't keep a WSL instance alive, only processes which are children of the Microsoft init" (https://github.com/microsoft/WSL/issues/8854 via issue 9072, read 2026-10-01). Workarounds: `vmIdleTimeout=-1` in `.wslconfig` (https://github.com/microsoft/WSL/issues/10138), or keep-alive processes such as `wsl.exe --exec dbus-launch true`. A 2026 write-up confirms the two boundaries: linger keeps the user manager alive inside a running distro, but nothing keeps the distro alive except a keep-alive process or external orchestration (https://danielcosenza.com/posts/wsl-fix-systemd-user-services/, read 2026-10-01).

| Option | Needs | What fails | Cost/month | Reaches PLAN.md | All of `~/dv` |
| --- | --- | --- | --- | --- | --- |
| systemd user timer under WSL2 | `~/.config/systemd/user/*.timer`, `loginctl enable-linger` | Does not start the VM. If WSL2 is down (no terminal open, no keep-alive), the timer fires only at next boot, late. Linger alone does not keep WSL2 up (source above). | ~0 | Yes, script writes into the repo | Yes, one timer per project or one scan |
| cron in WSL2 | cron service, `[boot] command` in `/etc/wsl.conf` | Same VM-lifetime problem; cron is not started by default and not kept alive when no terminal is open (https://github.com/microsoft/WSL/issues/9072) | ~0 | Yes | Yes |
| Windows Task Scheduler → `wsl.exe <command>` | One scheduled task at logon; `wsl.exe -d <distro> ...` starts the VM on demand | Runs only when the Windows user is logged in. Task Scheduler can also act as the keep-alive: it starts WSL2 when needed, which the Linux-side options cannot. Windows sleep/lid state applies. | ~0 | Yes | One task can loop over all projects |
| Claude Code routine (`/schedule`) | Cloud session with repository access | Runs in the cloud, cannot reach `~/dv` or the local opencode/GLM setup; PLAN.md already names this (step 17d). Also a paid cloud run. | Paid per run | Writes to the repo via push, not to the working tree | Yes, but remote only |
| Reminder only (a due-list printed by `doctor`) | 17c check `research-due` | Nothing runs when the user is away; rechecks wait until the user or the main thread opens the project. Zero unattended cost. | ~0 (only when the user is there) | Yes, PLAN.md lists it as an open task | Yes |

### Recommendation

Two-layer setup, judged by the criteria:

1. Detection is passive and cached: step 17b writes `recheck` into each report head, 17c's `doctor research-due` compares it with today and warns. A recheck that finds no change records the date (like `opencode-review.json`). This satisfies "no repeated work" and costs nothing while the user is away.
2. When the user approves unattended runs (step 17d, decision pending): a Windows Task Scheduler task at logon that runs `wsl.exe -d <distro> <runner>`; the runner loops over the due reports of all projects in `~/dv`, starts one researcher run per due report with a cost cap, appends "Recheck <date>", and adds a line to the open tasks of the user. Task Scheduler wins over systemd timer and cron because it can start the VM itself when the user is logged in, and the criteria that decide are "runs when the user is away" and "works for all projects in `~/dv`". systemd user timer or cron stay the fallback inside an already-running WSL session, but they cannot start it. Claude Code routines are out for local facts; a reminder-only setup is the interim state until 17d.

## 5. Open questions

- Exact WSL2 idle-timeout behaviour on this machine (Windows 11 build, `vmIdleTimeout` setting): to measure before 17d. The default is roughly 60 seconds after the last `init` child ends (sources above), but suspend states vary by Windows version.
- Whether Windows Task Scheduler is allowed to start WSL2 at logon on this machine, and whether the machine is normally logged in while the user is away. Unknown; needs the user's answer along with the 17d decision.
- `andimrob/docrot` maturity (stars, maintainer activity) could not be verified; GitHub API was rate-limited. Only used as a design reference, not a dependency.
- The MADR `schedule.time` / `timezone` wording was truncated in one fetch; not load-bearing for this report.

## 6. Search log

- reader: joelparkerhenderson ADR repo (redirected to the org repo) — review convention, immutability. 6 relevant hits.
- reader: MADR template — `status`, `date`, re-visit text. 5 relevant hits.
- reader: thoughtworks.com/radar, zalando tech-radar — cadence, rings. 4 relevant hits.
- reader: learn.microsoft.com metadata — `ms.date` + build validation. 5 relevant hits.
- reader: Antora intrinsic attributes, GitHub wikis docs — no freshness field in GitHub. 3 relevant hits.
- reader: Renovate scheduling docs, Dependabot config reference, Claude Code on the web (routines). 8 relevant hits.
- websearch: "WSL2 systemd user timer cron run when terminal closed" — 6 highly relevant hits (WSL issues 9072, 10138, 10157, 8642, Cosenza post).
- websearch: "GitHub Action markdown front matter expires review-by stale documentation" — 7 relevant hits (docrot, frontmatter-validator, docs-health-action, content-freshness-gate, gh-doccy, gh-aw frontmatter).
- gh search repos "documents expiry check", "expiring docs", "stale documentation ..." — 0 relevant hits, then API rate limit.
- `mango/documents-expiry-check` and `boyney123/expiring-docs`: both 404; repos appear deleted or renamed. Unknown.
