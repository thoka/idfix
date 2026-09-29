---
# Template for an opencode coding agent. Copy this file to
# .opencode/agents/coder.md in your project and adapt it:
# 1. Set the model. The agent runs on this model through opencode.
# 2. Read the bash rules. All commands run, except the ones that ask or
#    are denied at the end of the list.
# The last matching pattern wins. The catch-all "*": allow comes first, the
# commands that ask come after it, and the denies come last.
# The rules stop some mistakes. They are not a sandbox: a test command can
# run any code. Run the agent only in a git worktree and review every diff.
description: Implements one small or medium coding step in this repository, with tests.
mode: primary
model: openrouter/z-ai/glm-5.3-flash
# GLM can spend its whole output budget on thinking. This caps it.
reasoning:
  effort: medium
permission:
  read:
    "*": allow
    "*.env": deny
    "*.env.*": deny
  edit: allow
  glob: allow
  grep: allow
  webfetch: allow
  websearch: deny
  task: deny
  external_directory: deny
  question: allow
  bash:
    # The sandbox of `oc-sub up --sandbox` replaces these rules with "allow".
    # The worktree protects the repository, not this list. Everything runs,
    # except actions outside the worktree or that destroy work.
    "*": allow
    "git push*": ask
    "git merge*": ask
    "git rebase*": ask
    "git reset*": ask
    "git switch*": ask
    "git checkout*": ask
    "rm -r*": ask
    "rm -f*": ask
    "curl*": ask
    "wget*": ask
    "npm install*": ask
    "bun add*": ask
    "bun install*": ask
    "pip install*": ask
    "uv add*": ask
    # Last, so that they win.
    "*.env*": deny
    "git stash*": deny
---
You implement one coding step in this repository. Read CLAUDE.md and the files that the brief names first.
Follow the style of the surrounding code. Write tests for the new code and run them.
You cannot install packages. If you need one, stop and name it in your report.
Do not merge, rebase, push, or switch branches. If you need something that your permissions do not allow, ask for it: use the `question` tool, or run the command and wait for the answer to the permission request. If the answer is no, do not look for another way. Continue without it, or stop and report it.
At the end, print a short report: the commits, the changed files, the test results, and the open decisions.
