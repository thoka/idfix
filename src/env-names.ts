/**
 * The environment variables of idfx and their old names. Step 24.3 renamed
 * `OC_SUB_URL`, `OC_SUB_OWNER`, and `OC_SUB_SHARED_DIR` to `IDFX_URL`,
 * `IDFX_OWNER`, and `IDFX_SHARED_DIR`. The code reads each variable only
 * through `idfxEnv`: the new name first, then the old name. A blank value
 * counts as unset, so a blank new name does not hide a set old name. The
 * `env-names` check of `doctor` warns while only an old name is set.
 */
import type { Env } from "./config";

/** One variable: its new name and its old name. */
export type EnvName = { name: string; old: string };

/** The variables of idfx, by key. */
export const ENV_NAMES = {
  url: { name: "IDFX_URL", old: "OC_SUB_URL" },
  owner: { name: "IDFX_OWNER", old: "OC_SUB_OWNER" },
  sharedDir: { name: "IDFX_SHARED_DIR", old: "OC_SUB_SHARED_DIR" },
} as const satisfies Record<string, EnvName>;

export type EnvKey = keyof typeof ENV_NAMES;

function setValue(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

/**
 * The value of a variable of idfx: the new name when it is set and not
 * blank, else the old name when it is set and not blank, else undefined.
 * Pure.
 */
export function idfxEnv(env: Env, key: EnvKey): string | undefined {
  const { name, old } = ENV_NAMES[key];
  return setValue(env[name]) ?? setValue(env[old]);
}

/** The variables that have only the old name set, in the order of `ENV_NAMES`. Pure. */
export function oldOnlyEnvNames(env: Env): EnvName[] {
  return Object.values(ENV_NAMES).filter(({ name, old }) => setValue(env[name]) === undefined && setValue(env[old]) !== undefined);
}
