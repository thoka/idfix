# Agent rules

## Purpose

This project makes cheap opencode subagents (for example GLM through OpenRouter) usable from Claude Code: a small tool to start, watch, and review a run, and a Claude Code skill with the knowledge how to use them.

## Domain

- Purpose: make coding agent sessions easy to start, watch, and review from one place, for opencode subagents and Claude Code sessions.
- Owns: the CLI `idfx` (runs, sandboxes, the cost proxy, `doctor`, `top`, `idfx watch` and its event log), the opencode plugin and its agents, the skill `idfx`, and the systemd unit in `contrib/`.
- Does not own: the configuration of the machine (shell settings, links into `~/.local/bin`, the install of the unit), the shared agent rules and skills that `IDFX_SHARED_DIR` points to, the `handover` tool that `idfx watch` calls, and the decisions that act on its events.
- Delegator: the user.

## Rules

- The user writes in German. You reply in English. All code and documentation are in English, in plain English.
- Use the current best practice. Research before you design or decide, instead of guessing. Research reports go into `.plan/research/`.
- Install the necessary tools and runtimes through mise (`mise.toml`).
- Use established libraries instead of own code.
- Small steps, each with tests and documentation.
- Do not read or print `.env` files or keys.
- This repository is public. It names no local path, no private project, and no private decision. The planning files (`PLAN.md`, `HISTORY.md`, `EXPERIENCE.md`, `review-queue.md`, `research/`, `design/`, `reports/`, `outbox/`) live in a private companion repository, cloned into the git-ignored folder `.plan/`. `.handover.toml` sets `plan_dir = ".plan"`. A worktree has no `.plan/`, so read the plan in the main checkout. Check: the pre-commit hook in `lefthook.yml` runs `public-check` on the staged files, and `test/public.test.ts` fails on a local path in a tracked file outside `.public-check-allow`.
