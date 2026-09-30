# Research: a working mise inside the oc-sub sandbox

Date: 2026-09-30. Research only, no code changes. Many claims were tested live inside a real
`sbx` sandbox (user `agent`, Ubuntu 26.04.1, host mise installs mounted read-only at
`/home/toka/.local/share/mise/installs` via virtiofs `ro`).

## Answers

### 1. Can the host mise binary run inside the sandbox?

Probably yes, but it is not needed, and it was not directly testable: the sandbox mounts only
`~/.local/share/mise/installs`, so the host binary at `~/.local/bin/mise` is not reachable from
inside. mise's official release binaries are statically linked and the freshly downloaded
2026.9.16 binary ran fine on Ubuntu 26.04.1, so a host binary would most likely run too.
Mounting a single file read-only with `sbx create` is uncertain (the project uses directory
mounts only, see `src/sandbox.ts:484-485`).

The simpler and strictly version-equal option: **add `mise` itself as a tool in `mise.toml`**
(`[tools] mise = "<version>"`). The host `mise install` (already run by `up`,
`src/sandbox.ts:472`) then puts `mise/<version>/bin/mise` into the installs folder, which the
sandbox already mounts read-only. No new mount, no installer, no curl at `up` time, and host
and sandbox use the identical binary. Tested inside the sandbox: the installed-by-mise binary
was not present in this host's installs dir, but the mechanism is the same as for `bun` etc.
(alternative: pin mise in the sandbox image — but then versions can drift from the host).

### 2. Does mise support a read-only shared install folder? — Yes

mise v2026.3.9 (PR jdx/mise#8581) added exactly this, marked `[experimental]`:

- Setting `shared_install_dirs` (type `string[]`), env `MISE_SHARED_INSTALL_DIRS`
  (colon-separated on Unix). Docs: https://mise.jdx.dev/configuration/settings.html —
  "A list of additional directories to search for installed tool versions. These directories
  are checked after the primary install directory ... They are read-only—mise will never
  install tools into these directories."
- A system dir `/usr/local/share/mise/installs` (`MISE_SYSTEM_DATA_DIR/installs`) is checked
  automatically when it exists; also `system_installs_dir` setting and
  `mise install --system` / `--shared DIR` flags exist.
- Lookup order: primary install dir → system dir → user-configured shared dirs
  (https://github.com/jdx/mise/pull/8581). Missing `.mise-installs.toml` manifests fall back
  to a directory-name heuristic, which the existing host installs dir satisfies.
- Release notes: https://github.com/jdx/mise/releases/tag/v2026.3.9
- e2e test: https://github.com/jdx/mise/blob/443e8319/e2e/cli/test_shared_install_dirs

Repo health: jdx/mise has ~34.5k stars, pushed 2026-09-30, 21 open issues — very active.

### 3. No overlay or symlink design needed

`MISE_SHARED_INSTALL_DIRS` is the purpose-built design (the Docker cookbook documents it for
exactly this use case, https://mise.jdx.dev/mise-cookbook/docker.html). Symlink farms or
overlay filesystems add fragility for no gain.

### 4. Settings needed inside the sandbox — tested live

Commands run inside the sandbox (downloads via the GET/HEAD-only `sbx` proxy):

```
export MISE_DATA_DIR=/home/agent/.local/share/mise-test
export MISE_SHARED_INSTALL_DIRS=/home/toka/.local/share/mise/installs   # the ro mount
mise --version                        # 2026.9.16 linux-x64
mise x bun@1.4.2 -- bun --version     # 1.4.2, resolved from the shared dir, no download
mise ls node                          # "node 24.20.0 (shared)" — host version reused
mise x github:docker/sbx-releases@0.45.1 -- sbx --help   # works, from shared dir
mise x ripgrep@latest -- rg --version # downloaded fresh into the writable data dir (5.6 MB)
mise settings set trusted_config_paths '["/home/**"]'   # makes the worktree mise.toml trusted
```

- `MISE_DATA_DIR`: must point somewhere writable (default `~/.local/share/mise` is fine —
  the sandbox home of `agent` is writable). New tools install here; the host mount is never
  written (verified: ripgrep landed in the sandbox data dir, nothing changed on the mount).
- `MISE_CACHE_DIR`: default (`~/.cache/mise`) is writable; no special setting needed.
- `MISE_CONFIG_DIR`: default `~/.config/mise` is writable. For trust, either the agent runs
  `mise trust` once per worktree, or `up` writes
  `trusted_config_paths = ["/home/**"]` into the sandbox config once (verified working).
- GitHub rate limit without a token: `curl https://api.github.com/rate_limit` from the
  sandbox showed the anonymous 60 requests/hour core limit, reachable through the proxy.
  Core/aqua/ubi backends download plain tarballs over GET and worked. The `github:` backend
  also worked for resolving and running an already-shared version; installing a *new*
  `github:` tool could hit the 60/h limit (shared with the host IP). Rare; acceptable.
- `mise install` works with GET/HEAD only for HTTP downloads; no POST is required by the
  paths tested. A token could later be injected like the OpenRouter key via `sbx secret`,
  but that is not needed now.

### 5. Changes needed (short list, no code)

1. `mise.toml`: add `mise = "<version>"` under `[tools]` so the binary ships in the installs
   dir (host and sandbox identical).
2. `src/sandbox.ts` (`upSandbox`, around lines 467-478 and the `sbx exec -e` block at
   599-627): after `mise install`, pass three extra env vars into the server:
   `MISE_SHARED_INSTALL_DIRS=<installsDir>` (the same ro mount path),
   optionally `MISE_CONFIG_DIR`/`MISE_DATA_DIR` left at defaults, and write
   `trusted_config_paths` into the sandbox mise config (same `sbx exec` style as the
   placeholder key file). Also ensure the mise tool bin dir lands on the server `PATH` — it
   already does, because `mise env --json` includes active tools, once mise is a tool.
3. Tests: unit tests in `test/` for the new env var wiring (the existing pattern around
   `miseBin`/`miseInstallsDir` at `src/sandbox.ts:242-278`).
4. `docs/GUIDE.md`: extend the sandbox bullet list (~line 164) with one bullet: mise is
   available inside the sandbox, reads host installs read-only via
   `MISE_SHARED_INSTALL_DIRS`, and installs new tools into the sandbox home.
5. `skills/oc-sub/reference.md`: one sentence in the sandbox section, so agents know
   `mise install` works and which versions it sees.

## Recommended design

Add `mise` itself to `[tools]` in `mise.toml`, so the sandbox's existing read-only installs
mount contains the mise binary — identical version to the host, no extra mount, no installer.
Inside the sandbox set a writable `MISE_DATA_DIR` (default home paths) and
`MISE_SHARED_INSTALL_DIRS=<host installs mount>`; mise then treats host versions as installed
(`(shared)`, never re-downloaded, never written) and installs new tools into the sandbox home.
`up` passes the env vars with the existing `sbx exec -e` pattern and writes
`trusted_config_paths = ["/home/**"]` into the sandbox mise config so worktree `mise.toml`
files are trusted without manual `mise trust`. Verified end-to-end inside a live sandbox.

## Open questions

- Host mise version: could not be read (host paths blocked for this agent); the
  `mise`-in-`mise.toml` design removes the need to know it.
- Does `sbx create` support mounting a single *file* read-only (relevant only if the
  `mise`-as-tool design is rejected)? Untested.
- Whether `github:`-backend *new* installs reliably fit the anonymous 60/h GitHub API limit
  under heavier use; only resolution was tested live.
- The `shared_install_dirs` feature is still marked `[experimental]` upstream; behavior
  changes (e.g. manifest handling, PR #13693 layout changes) should be re-checked on mise
  upgrades.
