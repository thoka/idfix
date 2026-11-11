/**
 * The environment variables of idfx: `IDFX_URL`, `IDFX_OWNER`,
 * `IDFX_SHARED_DIR`, and `IDFX_NO_SANDBOX`. The code reads each variable only through `idfxEnv`.
 * A blank value counts as unset. Step 24.3 renamed the variables, and
 * step 24.6 removed the old names: idfx reads only the new names.
 */
import type { Env } from "./config";

/** The variables of idfx, by key. */
export const ENV_NAMES = {
  url: "IDFX_URL",
  owner: "IDFX_OWNER",
  sharedDir: "IDFX_SHARED_DIR",
  noSandbox: "IDFX_NO_SANDBOX",
} as const;

export type EnvKey = keyof typeof ENV_NAMES;

/** The value of a variable of idfx when it is set and not blank, else undefined. Pure. */
export function idfxEnv(env: Env, key: EnvKey): string | undefined {
  const value = env[ENV_NAMES[key]];
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

/**
 * The declaration that this host runs no sandbox: the free reason text of
 * `IDFX_NO_SANDBOX`, or undefined when the name is absent, empty, or blank.
 * An absent name never declares anything, so a host that lost the setting
 * stays a fail in the doctor. Pure.
 */
export function noSandboxReason(env: Env): string | undefined {
  return idfxEnv(env, "noSandbox")?.trim();
}

/** The text of the named skip of a check that needs a sandbox host. */
export function noSandboxSkipText(reason: string): string {
  return `skipped: host declares no sandbox (${ENV_NAMES.noSandbox}): ${reason}`;
}

/**
 * The refusal of a sandbox start on a host that declares no sandbox, or
 * null when the host declares nothing. Every code path that creates or
 * starts a sandbox calls it before its first `sbx` call. Pure.
 */
export function noSandboxRefusal(env: Env): string | null {
  const reason = noSandboxReason(env);
  if (reason === undefined) return null;
  return `this host declares that it runs no sandbox (${ENV_NAMES.noSandbox}: ${reason}); idfx starts no sandbox here and does not fall back to a run without one`;
}
