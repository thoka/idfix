/**
 * The environment variables of idfx: `IDFX_URL`, `IDFX_OWNER`, and
 * `IDFX_SHARED_DIR`. The code reads each variable only through `idfxEnv`.
 * A blank value counts as unset. Step 24.3 renamed the variables, and
 * step 24.6 removed the old names: idfx reads only the new names.
 */
import type { Env } from "./config";

/** The variables of idfx, by key. */
export const ENV_NAMES = {
  url: "IDFX_URL",
  owner: "IDFX_OWNER",
  sharedDir: "IDFX_SHARED_DIR",
} as const;

export type EnvKey = keyof typeof ENV_NAMES;

/** The value of a variable of idfx when it is set and not blank, else undefined. Pure. */
export function idfxEnv(env: Env, key: EnvKey): string | undefined {
  const value = env[ENV_NAMES[key]];
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}
