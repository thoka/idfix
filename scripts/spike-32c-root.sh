#!/usr/bin/env bash
# Spike of step 32c (docs/design/runner-job-sandbox.md): the root setup for
# the user gh-runner and its own sbx daemon, a check run, and an undo.
#
#   sudo scripts/spike-32c-root.sh apply DOCKER_USER
#       Reads two lines on stdin: the Claude token, then the Docker PAT.
#       An empty line keeps the stored value. Values are never printed.
#   sudo scripts/spike-32c-root.sh check
#       Runs the spike checks as gh-runner. The log goes to /tmp/spike-32c.log.
#   sudo scripts/spike-32c-root.sh undo
#       Removes everything that apply made.
#
# Idempotent: apply and undo can run again.
set -euo pipefail
umask 077

RUNNER=gh-runner
RUNNER_HOME=/var/lib/gh-runner
SBX_VERSION=0.45.1 # same as mise.toml
SBX_PREFIX=/usr/local/lib/gh-runner/sbx
SBX="$SBX_PREFIX/bin/sbx"
CREDSTORE=/etc/credstore
CLAUDE_TOKEN_FILE="$CREDSTORE/claude-oauth.token"
DOCKER_PAT_FILE="$CREDSTORE/gh-runner-docker.pat"
ENV_FILE=/etc/gh-runner/spike.env
UNIT_DIR=/etc/systemd/system
DAEMON_UNIT=gh-runner-sbx.service
LOGIN_UNIT=gh-runner-sbx-login.service
SPIKE_SANDBOX=spike32c
LOG=/tmp/spike-32c.log

die() { echo "error: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this script with sudo"

# Reads one secret line from stdin without echo. An empty line keeps $2.
store_secret() {
  local prompt=$1 file=$2 value=""
  if [ -t 0 ]; then
    read -rs -p "$prompt (empty keeps the stored value): " value
    echo >&2
  else
    IFS= read -r value || true
  fi
  if [ -n "$value" ]; then
    install -d -m 700 -o root -g root "$CREDSTORE"
    printf '%s' "$value" >"$file.new"
    chmod 600 "$file.new"
    mv "$file.new" "$file"
    echo "stored $file"
  elif [ -f "$file" ]; then
    echo "kept $file"
  else
    die "no value for $file"
  fi
}

apply() {
  local docker_user=${1:-}
  [ -n "$docker_user" ] || die "usage: $0 apply DOCKER_USER"
  local src=${SBX_SRC:-/home/${SUDO_USER:-toka}/.local/share/mise/installs/github-docker-sbx-releases/$SBX_VERSION}
  [ -x "$src/sbx" ] || die "no sbx $SBX_VERSION in $src (set SBX_SRC)"

  # The user: a system user without sudo, docker, or wheel, with linger, so
  # that /run/user/<uid> exists for the daemon.
  if ! id "$RUNNER" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$RUNNER_HOME" --create-home \
      --shell /usr/sbin/nologin "$RUNNER"
    echo "created user $RUNNER"
  fi
  for group in wheel sudo docker; do
    if id -nG "$RUNNER" | tr ' ' '\n' | grep -qx "$group"; then
      gpasswd -d "$RUNNER" "$group" >/dev/null
    fi
  done
  loginctl enable-linger "$RUNNER"

  # sbx in a root-owned folder, because /home/toka is not readable for gh-runner.
  if [ "$("$SBX" version 2>/dev/null | grep -o "$SBX_VERSION" | head -1)" != "$SBX_VERSION" ]; then
    PREFIX="$SBX_PREFIX" "$src/install.sh" >/dev/null
    echo "installed sbx $SBX_VERSION to $SBX_PREFIX"
  fi

  store_secret "Claude token" "$CLAUDE_TOKEN_FILE"
  store_secret "Docker PAT" "$DOCKER_PAT_FILE"
  install -d -m 755 "$(dirname "$ENV_FILE")"
  printf 'DOCKER_USER=%s\n' "$docker_user" >"$ENV_FILE"
  chmod 644 "$ENV_FILE"

  local uid
  uid=$(id -u "$RUNNER")
  cat >"$UNIT_DIR/$DAEMON_UNIT" <<EOF
[Unit]
Description=sbx daemon of $RUNNER (spike 32c)
Wants=user@$uid.service
After=user@$uid.service network-online.target

[Service]
User=$RUNNER
Group=$RUNNER
Environment=HOME=$RUNNER_HOME XDG_RUNTIME_DIR=/run/user/$uid PATH=$SBX_PREFIX/bin:/usr/bin:/bin
ExecStart=$SBX daemon start --policy deny-all
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
  cat >"$UNIT_DIR/$LOGIN_UNIT" <<EOF
[Unit]
Description=sbx login of $RUNNER with a Docker PAT (spike 32c)
Requires=$DAEMON_UNIT
After=$DAEMON_UNIT

[Service]
Type=oneshot
RemainAfterExit=yes
User=$RUNNER
Group=$RUNNER
Environment=HOME=$RUNNER_HOME XDG_RUNTIME_DIR=/run/user/$uid PATH=$SBX_PREFIX/bin:/usr/bin:/bin
EnvironmentFile=$ENV_FILE
LoadCredential=docker-pat:$DOCKER_PAT_FILE
StandardInput=null
ExecStart=/bin/sh -c 'exec sbx login --username "\$DOCKER_USER" --password-stdin <"\$CREDENTIALS_DIRECTORY/docker-pat"'

[Install]
WantedBy=multi-user.target
EOF
  chmod 644 "$UNIT_DIR/$DAEMON_UNIT" "$UNIT_DIR/$LOGIN_UNIT"
  systemctl daemon-reload
  systemctl enable --now "$DAEMON_UNIT" >/dev/null 2>&1
  sleep 3
  systemctl restart "$LOGIN_UNIT" || true
  systemctl enable "$LOGIN_UNIT" >/dev/null 2>&1
  for unit in "$DAEMON_UNIT" "$LOGIN_UNIT"; do
    echo "$unit: $(systemctl is-active "$unit" || true)"
  done
  echo "next: sudo $0 check"
}

# Runs sbx as gh-runner. Exported variables pass through runuser, so no
# secret value appears on a command line.
as_runner() {
  HOME="$RUNNER_HOME" XDG_RUNTIME_DIR="/run/user/$(id -u "$RUNNER")" \
    PATH="$SBX_PREFIX/bin:/usr/bin:/bin" \
    runuser -u "$RUNNER" -- "$@" </dev/null
}

step() { echo; echo "== $*"; }

check() {
  id "$RUNNER" >/dev/null 2>&1 || die "no user $RUNNER, run apply first"
  exec > >(tee "$LOG") 2>&1
  chmod 644 "$LOG"
  echo "spike 32c check, $(date -Is)"

  step "1 units"
  for unit in "$DAEMON_UNIT" "$LOGIN_UNIT"; do
    echo "$unit: $(systemctl is-active "$unit" || true)"
  done
  journalctl -u "$LOGIN_UNIT" -n 5 --no-pager -o cat || true

  step "2 daemon answers, global policy"
  as_runner "$SBX" ls || echo "FAIL sbx ls"
  as_runner "$SBX" policy ls || echo "FAIL sbx policy ls"

  step "3 create a shell sandbox without a workspace"
  as_runner "$SBX" rm --force "$SPIKE_SANDBOX" >/dev/null 2>&1 || true
  local t0=$SECONDS
  as_runner "$SBX" create --name "$SPIKE_SANDBOX" shell || { echo "FAIL create"; return; }
  echo "create took $((SECONDS - t0)) s"

  step "4 sbx exec -e NAME passes the value from the environment"
  export SPIKE_VALUE="spike-$RANDOM-$RANDOM"
  local want got
  want=$(printf '%s' "$SPIKE_VALUE" | sha256sum | cut -c1-16)
  got=$(as_runner "$SBX" exec -e SPIKE_VALUE "$SPIKE_SANDBOX" sh -c 'printf %s "$SPIKE_VALUE" | sha256sum | cut -c1-16' || true)
  [ "$want" = "$got" ] && echo "PASS exec -e by name" || echo "FAIL exec -e by name (got '$got')"
  unset SPIKE_VALUE

  step "5 deny-all blocks, a sandbox rule allows"
  local probe='curl -sS -o /dev/null -w "%{http_code}" --max-time 10 https://api.anthropic.com/ || true'
  echo "before allow: $(as_runner "$SBX" exec "$SPIKE_SANDBOX" sh -c "$probe")"
  as_runner "$SBX" policy allow network --sandbox "$SPIKE_SANDBOX" \
    api.anthropic.com,platform.claude.com,claude.ai,downloads.claude.ai,registry.npmjs.org,storage.googleapis.com
  echo "after allow: $(as_runner "$SBX" exec "$SPIKE_SANDBOX" sh -c "$probe")"
  echo "github.com, not allowed: $(as_runner "$SBX" exec "$SPIKE_SANDBOX" sh -c 'curl -sS -o /dev/null -w "%{http_code}" --max-time 10 https://github.com/ || true')"

  step "6 claude -p with CLAUDE_CODE_OAUTH_TOKEN"
  CLAUDE_CODE_OAUTH_TOKEN=$(cat "$CLAUDE_TOKEN_FILE")
  export CLAUDE_CODE_OAUTH_TOKEN
  as_runner "$SBX" exec -e CLAUDE_CODE_OAUTH_TOKEN -e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 "$SPIKE_SANDBOX" sh -c '
    if ! command -v claude >/dev/null; then
      echo "claude missing, installing with npm"
      npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 || sudo npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 || { echo "FAIL install claude"; exit 1; }
    fi
    claude --version
    claude -p "Reply with the single word ok." --max-turns 1 && echo "PASS claude -p" || echo "FAIL claude -p"
  ' || true
  unset CLAUDE_CODE_OAUTH_TOKEN

  step "7 policy log of the sandbox"
  as_runner "$SBX" policy log "$SPIKE_SANDBOX" 2>&1 | tail -40 || true

  step "8 sbx rm removes the sandbox and its rules"
  as_runner "$SBX" rm --force "$SPIKE_SANDBOX" && echo "removed"
  as_runner "$SBX" policy ls 2>&1 | grep -c "$SPIKE_SANDBOX" | sed 's/^/rules left for the sandbox: /' || true

  echo; echo "log: $LOG"
}

undo() {
  for unit in "$LOGIN_UNIT" "$DAEMON_UNIT"; do
    systemctl disable --now "$unit" >/dev/null 2>&1 || true
    rm -f "$UNIT_DIR/$unit"
  done
  systemctl daemon-reload
  if id "$RUNNER" >/dev/null 2>&1; then
    loginctl disable-linger "$RUNNER" || true
    pkill -u "$RUNNER" || true
    sleep 2
    userdel --remove "$RUNNER" 2>/dev/null || userdel "$RUNNER"
    rm -rf "$RUNNER_HOME"
    echo "removed user $RUNNER"
  fi
  rm -f "$CLAUDE_TOKEN_FILE" "$DOCKER_PAT_FILE" "$ENV_FILE"
  rmdir "$(dirname "$ENV_FILE")" 2>/dev/null || true
  rm -rf /usr/local/lib/gh-runner
  echo "undo done"
}

case ${1:-} in
  apply) shift; apply "$@" ;;
  check) check ;;
  undo) undo ;;
  *) die "usage: $0 apply DOCKER_USER | check | undo" ;;
esac
