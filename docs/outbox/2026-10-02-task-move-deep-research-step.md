---
kind: task
from: opencode-subagents
date: 2026-10-02
---

Move step 21 of opencode-subagents (deep research tools for expensive decisions) into meta, with its reports. The user decided this on 2026-10-02: "move it, reports too". A practice for good deep research serves all projects. It does not belong to the oc-sub tooling. The global rule in `agents/AGENTS.md` ("use an established deep research tool") has no tested tool behind it yet.

Copy these files from `opencode-subagents/docs/research/` into `meta/docs/research/`, with the same names:

- `deep-research-tools.md`: the established tools, how a script calls them, the cost, and the quality evidence.
- `oss-deep-research.md`: the shortlist of open-source, self-deployable tools.
- `deep-research-eval/question-driver-layer.md`: the test question that every tool gets, word for word.

Change the paths `docs/research/...` inside the files if needed. After the import, opencode-subagents deletes the three files and links to meta instead.

`opencode-subagents/docs/research/api-browsers.md` stays in the project, because part 1 serves its step 22 (an agent browser for the reader). Part 2 (the Gemini web app as an API) belongs to this step. Link it from meta.

The step for `meta/docs/PLAN.md`, as the project plan had it:

The user decided on 2026-10-02: Gemini Deep Research, run by hand with the Google One plan, is the reference. We test open-source, self-deployable tools against it, with the same test question. Hosted APIs are out.

1. A researcher run picks the shortlist: `oss-deep-research.md` (done in a first version).
2. Install two or three tools in Docker, run the test question with a model through OpenRouter, and save each report in `docs/research/deep-research-eval/`.
3. Compare each report with the Gemini report: sources read, claims with sources, candidates found, depth on failure modes. Estimate the cost first and report the real cost.
4. The best tool becomes the default for expensive decisions, written as a rule or a skill in meta. The question of a driver layer above Claude gets its answer from the reports.

Open tasks of the user for this step:

- Choose the model for the open-source tools (a GPT-5-class model through OpenRouter, about $0.20 to $1.00 per report, or GLM). Create a Tavily key for open_deep_research. The key path was `~/.config/opencode-subagents/tavily.key`. In meta it becomes the key of the project that runs the tools.
- Decide whether to script the Gemini web app with `HanaokaYuzu/Gemini-API`. It breaches the Google terms. No ban case is documented. A separate Google account lowers the risk. See `api-browsers.md`, part 2.
- Run the test question by hand in Gemini Deep Research (Google One), and save the report as `docs/research/deep-research-eval/gemini-driver-layer.md`. It is the reference.

Known gap: `oss-deep-research.md` read only two pages through the page reader. It marks the rest of its sources as search excerpts or GitHub API data, so its shortlist rests on thin evidence.
