import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const UNIT = path.join(import.meta.dir, "..", "contrib", "systemd", "idfx-watch.service");

/** A small INI reader for a systemd unit: sections, `key=value` lines, and `#` or `;` comments. */
function parseUnit(text: string): Record<string, Record<string, string[]>> {
  const sections: Record<string, Record<string, string[]>> = {};
  let current: Record<string, string[]> | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header !== null) {
      current = sections[header[1] as string] ??= {};
      continue;
    }
    const eq = line.indexOf("=");
    if (current === undefined || eq <= 0) throw new Error(`not an INI line: ${line}`);
    const key = line.slice(0, eq).trim();
    (current[key] ??= []).push(line.slice(eq + 1).trim());
  }
  return sections;
}

describe("contrib/systemd/idfx-watch.service", () => {
  const unit = parseUnit(readFileSync(UNIT, "utf8"));

  test("parses as an INI file with the keys of design section 7", () => {
    expect(Object.keys(unit)).toEqual(["Unit", "Service", "Install"]);
    expect(unit.Unit?.Description?.[0]).toMatch(/idfx watch --all/);
    expect(unit.Service?.ExecStart).toEqual(["%h/.local/bin/idfx watch --all"]);
    expect(unit.Service?.Restart).toEqual(["on-failure"]);
    expect(unit.Service?.RestartSec).toEqual(["10"]);
    expect(unit.Install?.WantedBy).toEqual(["default.target"]);
  });

  test("the PATH names only generic folders, so a drop-in adds the others", () => {
    const env = unit.Service?.Environment?.[0] ?? "";
    expect(env).toMatch(/^PATH=/);
    expect(env.split("=")[1]?.split(":")).toEqual([
      "%h/.local/bin",
      "%h/.local/share/mise/shims",
      "/usr/local/bin",
      "/usr/bin",
    ]);
    expect(env).not.toContain("dv");
  });

  const analyze = Bun.which("systemd-analyze");
  test.skipIf(analyze === null)("systemd-analyze --user verify accepts it", () => {
    const result = Bun.spawnSync([analyze as string, "--user", "verify", UNIT]);
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
