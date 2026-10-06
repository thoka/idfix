/** `idfx run`: create a session, send the brief asynchronously, record it. */
import { existsSync } from "node:fs";
import path from "node:path";
import { appendCriticalFooter, readCriticalFooter } from "./critical-footer";
import { assertOk, errorMessage, makeClient, probeServer, requireServer, unwrap, type ServerState } from "./client";
import { resolvePort, type Env } from "./config";
import { idfxEnv } from "./env-names";
import {
  checkOpenRouterKey,
  keyFingerprint,
  projectNameOfRun,
  readTextFile,
  resolveDirectoryKey,
  sharedKeyRefusal,
  type KeyFetch,
  type KeyOwner,
} from "./keys";
import { acquireLock, lockServer, RUN_LOCK_WAIT, type AcquireLock, type Release } from "./lock";
import { makeRunRecord, writeRunRecord, writeStateRunRecord } from "./runs";
import {
  defaultRunner,
  readSandboxState,
  resolveCommandUrl,
  sandboxStatePath,
  sbxBin,
  upSandbox,
  type SandboxState,
} from "./sandbox";
import { addDir, readDirs, serveDirsPath, serveLockPath } from "./state";
import { uniqueDirectories, worktreesOf } from "./status";

/** The CODE that identifies a session for `idfx attach`: the last 6 characters. Pure. */
export function attachCode(sessionId: string): string {
  return sessionId.slice(-6);
}

/** The parts of run that the tests replace: fetch, git, the file system, and the working directory. */
export type RunDeps = {
  fetch: KeyFetch;
  projectName: (directory: string) => string;
  worktreesOf: (directory: string) => string[];
  exists: (file: string) => boolean;
  cwd: string;
  /** Whether a folder exists inside the sandbox. */
  existsInSandbox: (sandbox: string, directory: string, env: Env) => boolean;
  /** The health check of a server. Default: `GET /global/health`. */
  probe?: (url: string, env: Env) => Promise<ServerState>;
  /** Starts the sandbox server of the project of a folder (the `up` path). Returns its exit code. */
  startSandbox?: (directory: string, env: Env) => Promise<number>;
  /** Takes the server lock. Default: `proper-lockfile`. */
  acquireLock?: AcquireLock;
};

/**
 * The real start of a sandbox server: `upSandbox` with its defaults, so the
 * idle watchdog starts too. Its output goes to stderr, because the first
 * line on stdout of `run` is the session ID.
 */
async function defaultStartSandbox(directory: string, env: Env): Promise<number> {
  const log = console.log;
  console.log = (...parts: unknown[]) => console.error(...parts);
  try {
    return await upSandbox({ dir: directory }, env);
  } finally {
    console.log = log;
  }
}

const defaultDeps: RunDeps = {
  fetch,
  projectName: projectNameOfRun,
  worktreesOf,
  exists: existsSync,
  cwd: process.cwd(),
  existsInSandbox: (sandbox, directory, env) =>
    defaultRunner([sbxBin(env), "exec", sandbox, "test", "-d", directory]).exitCode === 0,
};

/**
 * The sandbox that `run` sends a run to, or null. Without `--url` and
 * `IDFX_URL`, a run goes to the sandbox of the project of `--dir` when a
 * sandbox state exists. Only then may `run` start a server that is down.
 */
export function sandboxTarget(
  args: { url?: string; dir: string },
  env: Env,
  projectName: (directory: string) => string,
): SandboxState | null {
  if (args.url !== undefined || idfxEnv(env, "url") !== undefined) return null;
  return readSandboxState(sandboxStatePath(env, projectName(path.resolve(args.dir))));
}

/**
 * The refusal of a run whose folder is missing in the sandbox, or null.
 * Without `--url` and `IDFX_URL`, `run` sends a run to the sandbox of the
 * project when a sandbox state exists. In clone mode the sandbox has its
 * own copy of the repository, so a worktree that `git worktree add` created
 * on the host does not exist there. opencode then fails the prompt with a
 * realPath error, and the session ends idle without an answer.
 */
export function missingSandboxFolder(
  args: { url?: string; dir: string },
  env: Env,
  deps: Pick<RunDeps, "projectName" | "existsInSandbox">,
): string | null {
  const directory = path.resolve(args.dir);
  const state = sandboxTarget(args, env, deps.projectName);
  if (state === null || deps.existsInSandbox(state.name, directory, env)) return null;
  const step = path.basename(path.dirname(directory)) === ".worktrees" ? path.basename(directory) : "STEP";
  return [
    `error: ${directory} does not exist in the sandbox ${state.name}.`,
    "The sandbox has its own clone of the repository, so a worktree created on the host is not there.",
    `Create the worktree inside the sandbox with: idfx worktree ${step}`,
    `Or run it on a host server: idfx up --no-sandbox, then idfx run --url http://127.0.0.1:<port> ...`,
  ].join("\n");
}

/**
 * The known directories, with the same sources as `idfx status --all`:
 * the dirs file of the server, the projects of the server, and their git
 * worktrees.
 */
async function knownDirectories(
  client: ReturnType<typeof makeClient>,
  baseUrl: string,
  env: Env,
  deps: Pick<RunDeps, "worktreesOf" | "exists">,
): Promise<string[]> {
  const port = resolvePort(undefined, baseUrl);
  const fromDirsFile = await readDirs(serveDirsPath(env, port));
  const projects = unwrap(await client.project.list({}), "list projects");
  const projectDirs = projects.map((project) => project.worktree).filter((dir) => dir !== "/");
  const base = uniqueDirectories([...fromDirsFile, ...projectDirs]);
  return uniqueDirectories([...base, ...base.flatMap((dir) => deps.worktreesOf(dir))]).filter((dir) =>
    deps.exists(dir),
  );
}

/**
 * Split a `--model PROVIDER/MODEL` value at the first `/` into the model
 * reference of the prompt request. Pure.
 */
export function splitModel(model: string): { providerID: string; modelID: string } {
  const index = model.indexOf("/");
  if (index === -1 || index === 0 || index === model.length - 1) {
    throw new Error(`--model must be PROVIDER/MODEL, got "${model}"`);
  }
  return { providerID: model.slice(0, index), modelID: model.slice(index + 1) };
}

/** The arguments of `idfx run`. */
export type RunArgs = { url?: string; agent: string; dir: string; briefFile?: string; text?: string; title?: string; model?: string };

export async function run(
  args: RunArgs,
  env: Env = process.env,
  deps: RunDeps = defaultDeps,
): Promise<number> {
  const baseUrl = resolveCommandUrl(args.url, env, args.dir, deps.projectName);
  const port = resolvePort(undefined, baseUrl);
  // The lock keeps the idle watchdog from stopping the server between the
  // health check and the prompt, and keeps two runs from starting the same
  // sandbox server twice.
  const release = await takeRunLock(env, port, deps.acquireLock ?? acquireLock);
  try {
    return await runLocked(args, env, deps, baseUrl, release);
  } finally {
    await release();
  }
}

/**
 * Starts the sandbox server of the project of `--dir` when `run` would use
 * it and it does not answer `GET /global/health`. In every other case (an
 * explicit URL, no sandbox state, a server that answers) it does nothing.
 * Returns 0, or the exit code of the failed start.
 */
export async function startSandboxIfDown(
  args: { url?: string; dir: string },
  env: Env,
  deps: Pick<RunDeps, "projectName" | "probe" | "startSandbox">,
  baseUrl: string,
): Promise<number> {
  if (sandboxTarget(args, env, deps.projectName) === null) return 0;
  const probe = deps.probe ?? ((url: string, probeEnv: Env) => probeServer(url, probeEnv, 5000));
  if ((await probe(baseUrl, env)).state !== "down") return 0;
  const directory = path.resolve(args.dir);
  const code = await (deps.startSandbox ?? defaultStartSandbox)(directory, env);
  if (code === 0) console.error(`started the sandbox server of ${deps.projectName(directory)} (it was down)`);
  return code;
}

/** Takes the lock of the server on `port`, or throws an error that names the lock. */
async function takeRunLock(env: Env, port: number, acquire: AcquireLock): Promise<Release> {
  let release: Release;
  try {
    release = await lockServer(env, port, RUN_LOCK_WAIT, acquire);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `cannot take the server lock ${serveLockPath(env, port)}: ${reason}. ` +
        "Another idfx run or the idle watchdog holds it. Try again in a minute.",
    );
  }
  // `run` releases after the prompt and again at its end, so only the first call counts.
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await release();
  };
}

/** The part of `run` that holds the server lock. It calls `release` once the prompt is sent. */
async function runLocked(
  args: RunArgs,
  env: Env,
  deps: RunDeps,
  baseUrl: string,
  release: Release,
): Promise<number> {
  const directory = path.resolve(args.dir);
  // A sandbox server that is down starts here, before the folder check:
  // that check runs `sbx exec` in the sandbox.
  const started = await startSandboxIfDown(args, env, deps, baseUrl);
  if (started !== 0) return started;
  const missing = missingSandboxFolder(args, env, deps);
  if (missing !== null) {
    console.error(missing);
    return 1;
  }
  await requireServer(baseUrl, env);
  const client = makeClient(baseUrl, env);

  const text = args.briefFile !== undefined ? await readBrief(args.briefFile) : (args.text ?? "");
  // Every research brief ends with the footer of the skill critical-research.
  const brief = args.agent === "researcher" ? appendCriticalFooter(text, readCriticalFooter(env)) : text;

  // Each project needs its own OpenRouter key. Resolve the key of the run
  // directory and of every other known directory, and refuse a shared key
  // before the session exists.
  const runKey = await resolveDirectoryKey(client, directory, env, {
    readText: readTextFile,
  }).catch(() => null);
  let fingerprint: string | undefined;
  let usageAtStart: number | null = null;
  if (runKey !== null) {
    const project = deps.projectName(directory);
    const owners: KeyOwner[] = [];
    for (const dir of await knownDirectories(client, baseUrl, env, deps)) {
      if (dir === directory) continue;
      try {
        const key = await resolveDirectoryKey(client, dir, env, { readText: readTextFile });
        owners.push({
          project: deps.projectName(dir),
          fingerprint: key?.fingerprint ?? null,
          isProjectKey: key?.isProjectKey ?? false,
        });
      } catch (error) {
        // One broken project must not stop the run, like in `status --all`.
        console.error(`warning: ${dir}: ${error instanceof Error ? error.message : errorMessage(error)}`);
      }
    }
    const refusal = sharedKeyRefusal(
      { project, fingerprint: runKey.fingerprint, isProjectKey: runKey.isProjectKey },
      owners,
      env,
    );
    if (refusal !== null) {
      console.error(refusal);
      return 1;
    }
    fingerprint = keyFingerprint(runKey.key);
    // The real cost of the run is the growth of the key usage at OpenRouter.
    // Without an answer, the run still starts and the real cost stays unknown.
    const check = await checkOpenRouterKey(runKey.key, deps.fetch);
    usageAtStart = check.status === "ok" ? check.usage : null;
  }

  const created = unwrap(
    await client.session.create({
      query: { directory },
      body: args.title === undefined ? {} : { title: args.title },
    }),
    "create session",
  );

  assertOk(
    await client.session.promptAsync({
      path: { id: created.id },
      query: { directory },
      body: {
        agent: args.agent,
        parts: [{ type: "text", text: brief }],
        ...(args.model === undefined ? {} : { model: splitModel(args.model) }),
      },
    }),
    "send brief",
  );
  // The session works now, so the idle watchdog sees it as busy.
  await release();

  const record = makeRunRecord({
    sessionId: created.id,
    directory,
    agent: args.agent,
    title: args.title,
    keyFingerprint: fingerprint,
    usageAtStart,
  });
  const recordPath = await writeRunRecord(deps.cwd, record);
  const stateRecordPath = await writeStateRunRecord(env, record);
  // `idfx down` checks these directories for busy sessions.
  await addDir(serveDirsPath(env, resolvePort(undefined, baseUrl)), directory);

  console.log(created.id);
  console.log(`watch live: idfx attach ${attachCode(created.id)}`);
  console.log(`run record: ${recordPath}`);
  console.log(`run record (state): ${stateRecordPath}`);
  return 0;
}

async function readBrief(file: string): Promise<string> {
  try {
    return await Bun.file(file).text();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read brief file ${file}: ${reason}`);
  }
}
