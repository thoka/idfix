#!/bin/sh
# The test job of the pre-push hook (lefthook.yml).
# git-autopush waits for a free test slot of the machine and skips a tree
# that passed before. --snapshot runs the suite in a temporary detached
# worktree of the pushed commit, so a dirty file in this checkout cannot
# change the result. A person without git-autopush is not locked out: the
# job names what is missing and runs the plain suite.
if command -v git-autopush >/dev/null 2>&1; then
  exec git-autopush tests --snapshot -- ${TEST_RUNNER:-mise run test}
fi
echo "git-autopush not found on the PATH: running the plain suite, with no test slot and no snapshot"
${TEST_RUNNER:-mise run test}
