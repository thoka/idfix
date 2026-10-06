/**
 * Generates the probe fixture: `probe/fixture/types.ts`, a deterministic
 * TypeScript file of 11,656 lines with three interfaces at fixed lines, plus
 * `probe/expected.json` with the expected answer.
 *
 * The file reproduces the A/B test task from .plan/EXPERIENCE.md: the probe
 * agent must find the three interfaces with grep and paged reads and write
 * their field names into `answer.md`. The generated file is committed, so
 * regenerating it only matters when the layout changes.
 *
 * Run with: bun probe/make-fixture.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const TOTAL_LINES = 11_656;

/** The three interfaces and the lines where they start (1-based). */
const INTERFACES = [
  {
    line: 4_868,
    name: "ProbeLedgerEntry",
    fields: [
      { name: "entryId", type: "string" },
      { name: "recordedAt", type: "string" },
      { name: "amountMinor", type: "number" },
      { name: "currencyCode", type: "string" },
      { name: "memo", type: "string" },
      { name: "settled", type: "boolean" },
    ],
  },
  {
    line: 5_047,
    name: "ProbeManifestField",
    fields: [
      { name: "key", type: "string" },
      { name: "label", type: "string" },
      { name: "required", type: "boolean" },
      { name: "maxLength", type: "number" },
    ],
  },
  {
    line: 7_820,
    name: "ProbeReplicaConfig",
    fields: [
      { name: "region", type: "string" },
      { name: "lagBudgetMs", type: "number" },
      { name: "readonly", type: "boolean" },
      { name: "backfillBatch", type: "number" },
      { name: "healthEndpoint", type: "string" },
    ],
  },
] as const;

/** Deterministic filler line for position n (0-based). */
function fillerLine(n: number): string {
  const i = n + 1;
  switch (n % 5) {
    case 0:
      return `// filler line ${i}: padding to reproduce the size of the A/B test file`;
    case 1:
      return `export const fillerConstant${i} = ${i};`;
    case 2:
      return `// filler line ${i}: no real type here, keep searching`;
    case 3:
      return `const fillerUnused${i} = ${i} * 2 + 1;`;
    default:
      return `export function fillerHelper${i}(x: number): number { return x + ${i}; }`;
  }
}

function interfaceBlock(spec: (typeof INTERFACES)[number]): string[] {
  const lines = [`export interface ${spec.name} {`];
  for (const field of spec.fields) {
    lines.push(`  ${field.name}: ${field.type};`);
  }
  lines.push("}");
  return lines;
}

/** Build the file so that each interface starts exactly at its target line. */
export function buildFixtureLines(): string[] {
  const byLine = new Map<number, string[]>();
  for (const spec of INTERFACES) byLine.set(spec.line, interfaceBlock(spec));
  const lines: string[] = [];
  let n = 0;
  while (lines.length < TOTAL_LINES) {
    const block = byLine.get(lines.length + 1);
    if (block) {
      lines.push(...block);
    } else {
      lines.push(fillerLine(n));
      n += 1;
    }
  }
  return lines;
}

function expectedJson(): string {
  return `${JSON.stringify(
    {
      interfaces: INTERFACES.map((spec) => ({
        name: spec.name,
        line: spec.line,
        fields: spec.fields.map((f) => f.name),
      })),
    },
    null,
    2,
  )}\n`;
}

function main(): void {
  const dir = path.dirname(new URL(import.meta.url).pathname);
  const lines = buildFixtureLines();
  mkdirSync(path.join(dir, "fixture"), { recursive: true });
  writeFileSync(path.join(dir, "fixture", "types.ts"), `${lines.join("\n")}\n`);
  writeFileSync(path.join(dir, "expected.json"), expectedJson());
  for (const spec of INTERFACES) {
    console.log(`${spec.name} at line ${spec.line} (${spec.fields.length} fields)`);
  }
  console.log(`wrote probe/fixture/types.ts with ${lines.length} lines and probe/expected.json`);
}

if (import.meta.main) main();
