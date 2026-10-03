/** `oc-sub run`: create a session, send the brief asynchronously, record it. */
import { existsSync } from "node:fs";
import path from "node:path";
import { assertOk, errorMessage, makeClient, requireServer, unwrap } from "./client";
import { resolvePort, type Env } from "./config";
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
import { makeRunRecord, writeRunRecord, writeStateRunRecord } from "./runs";
import { defaultRunner, readSandboxState, resolveCommandUrl, sandboxStatePath, sbxBin } from "./sandbox";
import { addDir, readDirs, serveDirsPath } from "./state";
import { uniqueDirectories, worktreesOf } from "./status";

/** The CODE that identifies a session for `oc-sub attach`: the last 6 characters. Pure. */
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
};

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
 * The refusal of a run whose folder is missing in the sandbox, or null.
 * Without `--url` and `OC_SUB_URL`, `run` sends a run to the sandbox of the
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
  if (args.url !== undefined || env.OC_SUB_URL !== undefined) return null;
  const directory = path.resolve(args.dir);
  const state = readSandboxState(sandboxStatePath(env, deps.projectName(directory)));
  if (state === null || deps.existsInSandbox(state.name, directory, env)) return null;
  const step = path.basename(path.dirname(directory)) === ".worktrees" ? path.basename(directory) : "STEP";
  return [
    `error: ${directory} does not exist in the sandbox ${state.name}.`,
    "The sandbox has its own clone of the repository, so a worktree created on the host is not there.",
    `Create the worktree inside the sandbox with: oc-sub worktree ${step}`,
    `Or run it on a host server: oc-sub up --no-sandbox, then oc-sub run --url http://127.0.0.1:<port> ...`,
  ].join("\n");
}

/**
 * The known directories, with the same sources as `oc-sub status --all`:
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

export async function run(
  args: { url?: string; agent: string; dir: string; briefFile?: string; text?: string; title?: string; model?: string },
  env: Env = process.env,
  deps: RunDeps = defaultDeps,
): Promise<number> {
  const missing = missingSandboxFolder(args, env, deps);
  if (missing !== null) {
    console.error(missing);
    return 1;
  }
  const baseUrl = resolveCommandUrl(args.url, env, args.dir);
  await requireServer(baseUrl, env);
  const directory = path.resolve(args.dir);
  const client = makeClient(baseUrl, env);

  const brief = args.briefFile !== undefined ? await readBrief(args.briefFile) : (args.text ?? "");

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
  // `oc-sub down` checks these directories for busy sessions.
  await addDir(serveDirsPath(env, resolvePort(undefined, baseUrl)), directory);

  console.log(created.id);
  console.log(`watch live: oc-sub attach ${attachCode(created.id)}`);
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
