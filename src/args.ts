/** Command line parsing for oc-sub. Pure: throws UsageError on bad input. */

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type ParsedArgs =
  | { command: "up"; url?: string; port?: number }
  | { command: "down" | "restart"; url?: string; port?: number; force: boolean }
  | { command: "run"; url?: string; agent: string; dir: string; briefFile?: string; text?: string; title?: string }
  | { command: "status"; url?: string; dir?: string }
  | { command: "ping"; url?: string; dir?: string }
  | { command: "watch"; url?: string; session: string; dir?: string; json: boolean }
  | { command: "log"; url?: string; session: string; dir?: string }
  | { command: "abort"; url?: string; session: string; dir?: string };

type Flags = Map<string, string | true>;
type Globals = { url?: string };

function isFlag(token: string): boolean {
  return token.startsWith("--") && token.length > 2;
}

function splitFlag(token: string): [string, string | undefined] {
  const eq = token.indexOf("=");
  if (eq === -1) return [token.slice(2), undefined];
  return [token.slice(2, eq), token.slice(eq + 1)];
}

/** Collect "--name value", "--name=value" and bare boolean flags into a map. */
function collectFlags(argv: readonly string[], known: ReadonlySet<string>, booleanFlags: ReadonlySet<string>): {
  flags: Flags;
  positionals: string[];
  globals: Globals;
} {
  const flags: Flags = new Map();
  const positionals: string[] = [];
  const globals: Globals = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) break;
    if (!isFlag(token)) {
      positionals.push(token);
      continue;
    }
    const [name, inlineValue] = splitFlag(token);
    if (!known.has(name)) {
      throw new UsageError(`unknown option --${name}`);
    }
    if (booleanFlags.has(name)) {
      if (inlineValue !== undefined) {
        throw new UsageError(`--${name} takes no value`);
      }
      flags.set(name, true);
      continue;
    }
    const value = inlineValue ?? argv[i + 1];
    if (value === undefined || isFlag(value)) {
      throw new UsageError(`--${name} needs a value`);
    }
    if (inlineValue === undefined) i++;
    flags.set(name, value);
  }
  const url = flags.get("url");
  if (url !== undefined) {
    if (typeof url !== "string" || url.trim().length === 0) {
      throw new UsageError("--url needs a non-empty value");
    }
    globals.url = url;
  }
  return { flags, positionals, globals };
}

function requireString(flags: Flags, name: string, what: string): string {
  const value = flags.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new UsageError(`${what} requires --${name}`);
  }
  return value;
}

function optionalString(flags: Flags, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parsePort(flags: Flags): number | undefined {
  const raw = flags.get("port");
  if (raw === undefined) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UsageError(`--port must be a number between 1 and 65535, got "${raw}"`);
  }
  return port;
}

function requireSession(positionals: readonly string[]): string {
  const session = positionals[0];
  if (session === undefined || session.trim().length === 0) {
    throw new UsageError("a session ID is required");
  }
  return session;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [head, ...rest] = argv;
  if (head === undefined) {
    throw new UsageError("no command given");
  }
  switch (head) {
    case "up": {
      const { flags, positionals, globals } = collectFlags(
        rest,
        new Set(["port", "url"]),
        new Set<string>(),
      );
      if (positionals.length > 0) {
        throw new UsageError(`up takes no positional arguments, got "${positionals.join(" ")}"`);
      }
      return { command: "up", url: globals.url, port: parsePort(flags) };
    }
    case "down":
    case "restart": {
      const { flags, positionals, globals } = collectFlags(
        rest,
        new Set(["port", "force", "url"]),
        new Set(["force"]),
      );
      if (positionals.length > 0) {
        throw new UsageError(`${head} takes no positional arguments, got "${positionals.join(" ")}"`);
      }
      return { command: head, url: globals.url, port: parsePort(flags), force: flags.get("force") === true };
    }
    case "run": {
      const { flags, positionals, globals } = collectFlags(
        rest,
        new Set(["agent", "dir", "brief", "title", "url"]),
        new Set<string>(),
      );
      const agent = requireString(flags, "agent", "run");
      const dir = requireString(flags, "dir", "run");
      const briefFile = optionalString(flags, "brief");
      const text = positionals.length > 0 ? positionals.join(" ") : undefined;
      if (briefFile !== undefined && text !== undefined) {
        throw new UsageError("give the brief either as --brief FILE or as TEXT, not both");
      }
      if (briefFile === undefined && text === undefined) {
        throw new UsageError("give the brief as --brief FILE or as TEXT");
      }
      return {
        command: "run",
        url: globals.url,
        agent,
        dir,
        briefFile,
        text,
        title: optionalString(flags, "title"),
      };
    }
    case "status": {
      const { flags, positionals, globals } = collectFlags(rest, new Set(["dir", "url"]), new Set<string>());
      if (positionals.length > 0) {
        throw new UsageError(`status takes no positional arguments, got "${positionals.join(" ")}"`);
      }
      return { command: "status", url: globals.url, dir: optionalString(flags, "dir") };
    }
    case "ping": {
      const { flags, positionals, globals } = collectFlags(rest, new Set(["dir", "url"]), new Set<string>());
      if (positionals.length > 0) {
        throw new UsageError(`ping takes no positional arguments, got "${positionals.join(" ")}"`);
      }
      return { command: "ping", url: globals.url, dir: optionalString(flags, "dir") };
    }
    case "watch": {
      const { flags, positionals, globals } = collectFlags(
        rest,
        new Set(["dir", "json", "url"]),
        new Set(["json"]),
      );
      const json = flags.get("json") === true;
      return {
        command: "watch",
        url: globals.url,
        session: requireSession(positionals),
        dir: optionalString(flags, "dir"),
        json,
      };
    }
    case "log": {
      const { flags, positionals, globals } = collectFlags(rest, new Set(["dir", "url"]), new Set<string>());
      return { command: "log", url: globals.url, session: requireSession(positionals), dir: optionalString(flags, "dir") };
    }
    case "abort": {
      const { flags, positionals, globals } = collectFlags(rest, new Set(["dir", "url"]), new Set<string>());
      return { command: "abort", url: globals.url, session: requireSession(positionals), dir: optionalString(flags, "dir") };
    }
    default:
      throw new UsageError(`unknown command "${head}"`);
  }
}
