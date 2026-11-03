import { existsSync } from "node:fs";

// The one place in idfix that names the schema folder of meta (step vKdE25Cb). A schema is code that the tests run
// against. test/setup.ts sets IDFIX_META_SCHEMAS (an override, else the declarations/schema folder of meta).
export function metaSchemas(): string {
  const dir = process.env.IDFIX_META_SCHEMAS ?? "";
  if (!existsSync(dir)) {
    throw new Error(`the schema folder of meta is missing (${dir}): check out meta there, or set IDFIX_META_SCHEMAS to its declarations/schema folder`);
  }
  return dir;
}
