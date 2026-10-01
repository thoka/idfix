# What opencode v1.18.32 writes into `OPENCODE_CONFIG_DIR`, and when

Researched 2026-10-01 from the source of tag `v1.18.32` at github.com/sst/opencode
(local shallow clone of the tag at `/tmp/opencode/src`). All line numbers refer to
that tag. The repo also hosts the same code under github.com/anomalyco/opencode
(same project; the tag resolves from `sst/opencode`).

## Criteria

- Which writes happen (file by file), by which function, triggered by which condition.
- Exact content written, exact package and version installed, which installer.
- Failure behavior: fatal per request or once, and why a restart seemed needed.
- Existence of an off-switch or redirect (env var or opencode.json flag).
- Practical host-side preparation so the server never needs to write.

## Short answers

1. **Which code writes what, and when.** During instance boot, `Config.loadInstanceState`
   loops over the config directories (`packages/opencode/src/config/config.ts:446-450`)
   and for each directory calls `Config.ensureGitignore` (writes `.gitignore` if it does
   not exist) and then forks a background `Npm.install` (`packages/opencode/src/config/config.ts:452-470`).
   `OPENCODE_CONFIG_DIR` is part of that directory list
   (`packages/opencode/src/config/paths.ts:30-46`). The `.gitignore` write happens only
   if the file is missing (existence check, no content compare). The npm install writes
   `package.json`, `package-lock.json`, and `node_modules/` only if `node_modules/` is
   missing, or if the lock file does not cover every declared dependency.

2. **Content and installer.** `.gitignore` gets exactly
   `node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore`
   (`config.ts:317`, joined with `\n`, no trailing newline). `package.json` and
   `package-lock.json` are written by npm's own library `@npmcli/arborist` (`reify`
   with `save: true`, `savePrefix: ""`, `ignoreScripts: true` — `packages/core/src/npm.ts:91-116`),
   so `package.json` gets a `dependencies` entry `"@opencode-ai/plugin": "1.18.32"`
   (exact version; `savePrefix: ""`). The package installed is `@opencode-ai/plugin`
   at the running opencode version (`config.ts:456-457`, version from
   `packages/core/src/installation/version.ts:6`, compile-time `OPENCODE_VERSION`, here 1.18.32).
   No `bun` or `npm` binary is spawned; arborist does everything in-process.

3. **Failure behavior.** The `.gitignore` write failure is fatal for that request, and
   the failure is not cached, so it repeats on every request. `ensureGitignore` only
   swallows `PermissionDenied` (`config.ts:320-322`); EROFS surfaces as reason tag
   `Unknown` (the observed `PlatformError: Unknown: FileSystem.writeFile`), propagates
   through `Effect.orDie` at `config.ts:450`, fails the instance boot
   (`project/instance-store.ts:72-77` removes the failed entry from the cache, and
   `project/bootstrap.ts:34-36` eagerly loads config on every boot), so the next request
   retries and fails again. The npm install is a separate background fiber and is skipped
   entirely on a read-only directory (`packages/core/src/npm.ts:148-152`), so it is not
   the fatal part. **The need for a restart is unconfirmed by the source**: once the
   folder was writable/copied, the next request should have re-booted the instance
   successfully without a restart.

4. **Off-switch.** None. There is no env var or opencode.json key in v1.18.32 that
   disables the `.gitignore` write or the plugin dependency install, or redirects them.
   `OPENCODE_DISABLE_PROJECT_CONFIG` does not help: it only removes the upward
   `.opencode` search; `OPENCODE_CONFIG_DIR` is appended to the directory list
   unconditionally (`paths.ts:43-46`). Full flag list in
   `packages/core/src/flag/flag.ts:21-73` — nothing disables this. (Unconfirmed beyond
   this tag: a newer version may add a flag; nothing found in the v1.18.32 tree.)

5. **Host-side preparation.** Create the folder once on the host with the four entries
   the server expects; since opencode only checks existence (`.gitignore`) and
   `node_modules/` (install), no further writes happen:

   ```sh
   mkdir -p <dir>
   cd <dir>
   npm install --save-exact --ignore-scripts @opencode-ai/plugin@<opencode-version>
   printf 'node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore' > .gitignore
   ```

   Then mount `<dir>` read-only into the sandbox. `Npm.install` sees the directory as
   not writable and returns immediately (`npm.ts:148-152`), and `.gitignore` exists so
   `ensureGitignore` writes nothing. Any existing `package.json` content is fine; when
   `node_modules/` exists, opencode does not touch it (no content or version comparison
   of the installed package).

## Details and sources

### 1. Who writes what, and the trigger

`Config.loadInstanceState` (`packages/opencode/src/config/config.ts`), for every
directory returned by `ConfigPaths.directories`:

```ts
// packages/opencode/src/config/config.ts:446-471
const directories = yield* ConfigPaths.directories(ctx.directory, ctx.worktree)
...
for (const dir of directories) {
  if (dir.endsWith(".opencode") || dir === Flag.OPENCODE_CONFIG_DIR) { ...load config files... }
  yield* ensureGitignore(dir).pipe(Effect.orDie)            // line 450
  const dep = yield* npmSvc
    .install(dir, {
      add: [
        {
          name: "@opencode-ai/plugin",
          version: InstallationLocal ? undefined : InstallationVersion,  // lines 456-457
        },
      ],
    })
    .pipe( Effect.exit, Effect.tap(... logWarning ...), Effect.asVoid, Effect.forkDetach )  // 461-470
  deps.push(dep)                                            // 471
```

`OPENCODE_CONFIG_DIR` is included in the directory list, unconditionally:

```ts
// packages/opencode/src/config/paths.ts:30-46 (directories)
return unique([
  Global.Path.config,
  ...(!Flag.OPENCODE_DISABLE_PROJECT_CONFIG ? ... : []),
  ...,
  ...(Flag.OPENCODE_CONFIG_DIR ? [Flag.OPENCODE_CONFIG_DIR] : []),
])
```

The `.gitignore` write — existence check only, no content or version compare:

```ts
// packages/opencode/src/config/config.ts:309-323 (Config.ensureGitignore)
const ensureGitignore = Effect.fn("Config.ensureGitignore")(function* (dir: string) {
  yield* fs.ensureDir(dir)
  const gitignore = path.join(dir, ".gitignore")
  const hasIgnore = yield* fs.existsSafe(gitignore)
  if (!hasIgnore) {
    yield* fs
      .writeFileString(
        gitignore,
        ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"].join("\n"),
      )
      .pipe(
        Effect.catchIf(
          (e) => e.reason._tag === "PermissionDenied",
          () => Effect.void,
        ),
      )
  }
})
```

Note: only `PermissionDenied` is swallowed. EROFS reaches the request as reason tag
`Unknown` (matching the observed `PlatformError: Unknown: FileSystem.writeFile ... EROFS`)
and is fatal (see below).

The package install — `Npm.install` (`packages/core/src/npm.ts:146-200`):

```ts
// packages/core/src/npm.ts:148-160
const canWrite = yield* afs.access(dir, { writable: true }).pipe(
  Effect.as(true),
  Effect.orElseSucceed(() => false),
)
if (!canWrite) return                       // read-only dir: install skipped silently
...
const nodeModulesExists = yield* afs.existsSafe(path.join(dir, "node_modules"))
if (!nodeModulesExists) {
  yield* reify({ add, dir })
  return true
}
```

If `node_modules/` exists, it only checks that the lock file covers every declared
dependency ("checkDirty"), and reifies only if something is unlocked:

```ts
// packages/core/src/npm.ts:173-192 (abridged)
const declared = new Set([
  ...Object.keys(pkgAny?.dependencies || {}), ... devDependencies, peerDependencies,
  optionalDependencies, ...(input?.add || []).map((pkg) => pkg.name),
])
const locked = new Set([...Object.keys(root?.dependencies || {}), ...])
for (const name of declared) {
  if (!locked.has(name)) {
    yield* reify({ dir, add })
    return
  }
}
```

So: with a prepared `node_modules/` and a `package-lock.json` that covers
`@opencode-ai/plugin`, the install does nothing. Without a lock file, opencode compares
declared-vs-locked per name; it does **not** compare installed versions against the
running opencode version (unconfirmed whether anything else does — the plugin loader has
a `checkPluginCompatibility` at `packages/opencode/src/plugin/loader.ts:127`, which reads
the installed plugin package, but it did not appear to rewrite `node_modules`).

### 2. Exact content and installer

`.gitignore` content (5 lines, no trailing newline), `config.ts:317`:

```
node_modules
package.json
package-lock.json
bun.lock
.gitignore
```

`package.json` / `package-lock.json` / `node_modules/` are produced by
`@npmcli/arborist` (npm's own dependency-tree library) in-process, not by spawning bun
or npm:

```ts
// packages/core/src/npm.ts:91-116 (Npm.reify)
const { Arborist } = yield* Effect.promise(() => import("@npmcli/arborist"))
const arborist = new Arborist({
  ...npmOptions,
  path: input.dir,
  binLinks: true,
  progress: false,
  savePrefix: "",
  ignoreScripts: true,
})
...
arborist.reify({ ...npmOptions, add, save: true, saveType: "prod" })
```

- `save: true` makes arborist write `package.json` and `package-lock.json` into the dir.
- `savePrefix: ""` means the saved range is exact, so `package.json` gets
  `"dependencies": { "@opencode-ai/plugin": "1.18.32" }` (unconfirmed for the exact
  serialization; arborist behavior, not shown in this repo).
- `ignoreScripts: true` — no lifecycle scripts run.

Package and version (`config.ts:454-458`): `@opencode-ai/plugin` at
`InstallationVersion` (`packages/core/src/installation/version.ts:6`), which is the
compile-time `OPENCODE_VERSION` — for the v1.18.32 binary, `1.18.32`
(`packages/opencode/package.json:3`). Only for a local dev build
(`InstallationLocal`, channel "local") is the version omitted, so npm resolves latest.

### 3. Why every `GET /session` failed, and the restart

Request path: `GET /session` → `InstanceContextMiddleware` loads the instance for the
request directory (`server/routes/instance/httpapi/middleware/instance-context.ts:20-33`)
→ `InstanceStore.boot` runs the bootstrap, which eagerly loads config:

```ts
// packages/opencode/src/project/bootstrap.ts:34-36
// everything depends on config so eager load it for nice traces
yield* config.get()
```

`config.get()` reads per-directory instance state and dies on failure:

```ts
// packages/opencode/src/config/config.ts:614-617
const state = yield* InstanceState.make<State>(
  Effect.fn("Config.state")(function* (ctx) {
    return yield* loadInstanceState(ctx).pipe(Effect.orDie)
  }),
)
```

`Effect.orDie` at `config.ts:450` turns the EROFS `.gitignore` write into a defect,
because the `PermissionDenied`-only catch at `config.ts:320-322` does not match the
`Unknown` reason tag.

The failure is not cached across requests: on boot failure the instance-store removes
the cache entry, so the next request boots again and fails again:

```ts
// packages/opencode/src/project/instance-store.ts:72-77
const completeLoad = (directory: string, input: LoadInput, entry: Entry) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(boot({ ...input, directory }))
    if (Exit.isFailure(exit)) yield* removeEntry(directory, entry)
    yield* Deferred.done(entry.deferred, exit).pipe(Effect.asVoid)
  })
```

This matches "every `GET /session` failed". It also implies that **a restart should not
have been strictly necessary** — once the four entries were copied, the next request
should have booted the instance cleanly. The observed restart requirement is therefore
unconfirmed by the source; possible explanations (a poisoned side cache elsewhere, or a
misattributed observation) were not found in this read. Note the opposite direction is
real: once a boot *succeeds*, the state is cached indefinitely
(`InstanceState.make` uses a `ScopedCache` with no TTL, `effect/instance-state.ts:38-48`),
which is why writes only happen once per directory.

### 4. Off-switch or redirect

None in v1.18.32. Checked the full flag surface
(`packages/core/src/flag/flag.ts:21-73`): `OPENCODE_DISABLE_AUTOUPDATE`, `..._PRUNE`,
`..._TERMINAL_TITLE`, `..._AUTOCOMPACT`, `..._MODELS_FETCH`, `..._MOUSE`, `..._FFF`,
`..._PROJECT_CONFIG`, `OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER`, `..._COPY_ON_SELECT`.
None touches `ensureGitignore` or `Npm.install`. `OPENCODE_DISABLE_PROJECT_CONFIG`
(`flag.ts:54-55`) only drops the upward `.opencode` directory search
(`paths.ts:33-35`); `OPENCODE_CONFIG_DIR` is still appended (`paths.ts:43-46`) and still
receives both the `.gitignore` write and the install. No opencode.json key was found
that controls this either (grep over `config.ts` for related keys).

### 5. Preparing the config folder on the host

One-time, on the host, before mounting read-only:

```sh
mkdir -p <dir>
cd <dir>
npm install --save-exact --ignore-scripts @opencode-ai/plugin@<opencode-version>
printf 'node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore' > .gitignore
```

Why this is sufficient:

- `.gitignore` exists → `ensureGitignore` writes nothing (`config.ts:312-313`).
- `node_modules/` exists → arborist never runs, provided `package-lock.json` covers
  `@opencode-ai/plugin` (npm install with `--save-exact` writes that lock). Even if the
  lock were incomplete, `Npm.install` returns early because the directory is not
  writable (`npm.ts:148-152`), logging nothing fatal.
- If the plugin is not actually needed, a stub also works: any `node_modules/` directory
  plus a `package.json`/lock makes the "checkNodeModules" branch return
  (`npm.ts:157-162`), and the install result is only used to resolve
  `@opencode-ai/plugin` when plugins are declared; an empty-but-present install just
  yields a resolution failure in the detached background fiber, which is only logged
  (`config.ts:462-467`), not fatal. Unconfirmed: we did not test the stub variant.

Caveat: mount the folder read-only *and* keep owner write on the host. Do not put
`OPENCODE_CONFIG_DIR` on a filesystem where even the host side cannot create
`node_modules` — the npm install would fail (only a warning), but the `.gitignore`
write would still kill every request if the file were missing.

## Open questions

- Why the restart appeared necessary in the 2026-10-01 incident; the source suggests a
  retry per request (`instance-store.ts:75`). Not resolved.
- Exact serialization of `package.json` by arborist with `savePrefix: ""` (library
  behavior, not in this repo).
- Whether `checkPluginCompatibility` (`plugin/loader.ts:127`) can trigger rewrites of
  `node_modules` at plugin load time; not traced.
- Whether a version newer than v1.18.32 adds a disable flag; only this tag was checked.

## Search log (for repetition)

- Source: `git clone --depth 1 --branch v1.18.32 https://github.com/sst/opencode` → 1 hit (the tag exists on sst/opencode).
- `grep -rn "gitignore" packages/opencode/src` → ~10 hits; key hit `config/config.ts:309-323`.
- `grep -rn "npmSvc|Npm" packages/opencode/src` → `config/config.ts:183,452`; service in `packages/core/src/npm.ts`.
- `grep -n "DISABLE" packages/core/src/flag/flag.ts` → 12 flags, none relevant.
- `gh`-based GitHub search was unavailable (API rate limit 403, unauthenticated); npm
  registry search was not needed — the package is in-repo code, not an external tool.
