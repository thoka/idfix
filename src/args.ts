/** Command line parsing for oc-sub. Pure: throws UsageError on bad input. */

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type ParsedArgs =
  | { command: "up"; url?: string; port?: number; sandbox: boolean; dir?: string }
  | { command: "down" | "restart"; url?: string; port?: number; force: boolean; sandbox: boolean; dir?: string }
  | { command: "run"; url?: string; agent: string; dir: string; briefFile?: string; text?: string; title?: string }
  | { command: "status"; url?: string; dir?: string; all: boolean }
  | { command: "top"; url?: string; dir?: string; all: boolean; once: boolean; json: boolean }
  | { command: "attach"; url?: string; code: string }
  | { command: "ping"; url?: string; dir?: string }
  | { command: "watch"; url?: string; session: string; dir?: string; json: boolean }
  | { command: "log"; url?: string; session: string; dir?: string }
  | { command: "abort"; url?: string; session: string; dir?: string }
  | {
      command: "answer";
      url?: string;
      request: string;
      dir?: string;
      reply?: Reply;
      reject: boolean;
      message?: string;
      answers: string[];
    }
  | { command: "say"; url?: string; session: string; dir?: string; agent?: string; text: string };

/** The reply values of a permission request. */
export type Reply = "once" | "always" | "reject";

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

/**
 * The shared flags of up, down, and restart. Sandbox mode is the default.
 * `--no-sandbox` selects the host server. `--port` and `--url` name a host
 * server, so they imply host mode too. `--dir` is only allowed in sandbox
 * mode, and `--sandbox` cannot name a server itself, because the URL and the
 * port come from the sandbox state.
 */
function parseSandboxFlags(flags: Flags, globals: Globals): { sandbox: boolean; dir?: string } {
  const sandboxFlag = flags.get("sandbox") === true;
  const noSandbox = flags.get("no-sandbox") === true;
  const namesHost = noSandbox || globals.url !== undefined || flags.has("port");
  if (sandboxFlag && noSandbox) {
    throw new UsageError("--sandbox and --no-sandbox cannot be combined");
  }
  if (sandboxFlag && (globals.url !== undefined || flags.has("port"))) {
    throw new UsageError("--sandbox cannot be combined with --url or --port, they already name a host server");
  }
  const dir = optionalString(flags, "dir");
  if (dir !== undefined && namesHost) {
    throw new UsageError("--dir is only allowed in sandbox mode, not with --no-sandbox, --url, or --port");
  }
  return { sandbox: !namesHost, dir };
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
        new Set(["port", "url", "sandbox", "no-sandbox", "dir"]),
        new Set(["sandbox", "no-sandbox"]),
      );
      if (positionals.length > 0) {
        throw new UsageError(`up takes no positional arguments, got "${positionals.join(" ")}"`);
      }
      return {
        command: "up",
        url: globals.url,
        port: parsePort(flags),
        ...parseSandboxFlags(flags, globals),
      };
    }
    case "down":
    case "restart": {
      const { flags, positionals, globals } = collectFlags(
        rest,
        new Set(["port", "force", "url", "sandbox", "no-sandbox", "dir"]),
        new Set(["force", "sandbox", "no-sandbox"]),
      );
      if (positionals.length > 0) {
        throw new UsageError(`${head} takes no positional arguments, got "${positionals.join(" ")}"`);
      }
      return {
        command: head,
        url: globals.url,
        port: parsePort(flags),
        force: flags.get("force") === true,
        ...parseSandboxFlags(flags, globals),
      };
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
      const { flags, positionals, globals } = collectFlags(rest, new Set(["dir", "url", "all"]), new Set(["all"]));
      if (positionals.length > 0) {
        throw new UsageError(`status takes no positional arguments, got "${positionals.join(" ")}"`);
      }
      const dir = optionalString(flags, "dir");
      if (flags.get("all") === true && dir !== undefined) {
        throw new UsageError("--all and --dir cannot be combined");
      }
      return { command: "status", url: globals.url, dir, all: flags.get("all") === true };
    }
    case "top": {
      const { flags, positionals, globals } = collectFlags(
        rest,
        new Set(["dir", "url", "all", "once", "json"]),
        new Set(["all", "once", "json"]),
      );
      if (positionals.length > 0) {
        throw new UsageError(`top takes no positional arguments, got "${positionals.join(" ")}"`);
      }
      const dir = optionalString(flags, "dir");
      if (flags.get("all") === true && dir !== undefined) {
        throw new UsageError("--all and --dir cannot be combined");
      }
      return {
        command: "top",
        url: globals.url,
        dir,
        all: flags.get("all") === true,
        once: flags.get("once") === true,
        json: flags.get("json") === true,
      };
    }
    case "attach": {
      const { flags, positionals, globals } = collectFlags(rest, new Set(["url"]), new Set<string>());
      const code = positionals[0];
      if (code === undefined || code.trim().length === 0) {
        throw new UsageError("a CODE is required, a part of the session ID");
      }
      if (positionals.length > 1) {
        throw new UsageError(`attach takes one CODE, got "${positionals.join(" ")}"`);
      }
      return { command: "attach", url: globals.url, code };
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
    case "answer": {
      const { flags, positionals, globals } = collectFlags(
        rest,
        new Set(["dir", "url", "reply", "reject", "message"]),
        new Set(["reject"]),
      );
      const request = positionals[0];
      if (request === undefined || request.trim().length === 0) {
        throw new UsageError("a request ID is required");
      }
      const answers = positionals.slice(1);
      const replyRaw = optionalString(flags, "reply");
      let reply: Reply | undefined;
      if (replyRaw !== undefined) {
        if (replyRaw !== "once" && replyRaw !== "always" && replyRaw !== "reject") {
          throw new UsageError(`--reply must be once, always, or reject, got "${replyRaw}"`);
        }
        reply = replyRaw;
      }
      const reject = flags.get("reject") === true;
      if (reject && reply !== undefined) {
        throw new UsageError("--reject and --reply cannot be combined");
      }
      if (reject && answers.length > 0) {
        throw new UsageError("--reject takes no answers");
      }
      if (!reject && reply === undefined && answers.length === 0) {
        throw new UsageError("give one answer per question, --reply once|always|reject, or --reject");
      }
      const message = optionalString(flags, "message");
      if (message !== undefined && reply !== "reject") {
        throw new UsageError("--message is only allowed with --reply reject");
      }
      return {
        command: "answer",
        url: globals.url,
        request,
        dir: optionalString(flags, "dir"),
        reply,
        reject,
        message,
        answers,
      };
    }
    case "say": {
      const { flags, positionals, globals } = collectFlags(rest, new Set(["dir", "agent", "url"]), new Set<string>());
      const session = requireSession(positionals);
      const text = positionals.slice(1).join(" ");
      if (text.trim().length === 0) {
        throw new UsageError("a message TEXT is required after the session ID");
      }
      return {
        command: "say",
        url: globals.url,
        session,
        dir: optionalString(flags, "dir"),
        agent: optionalString(flags, "agent"),
        text,
      };
    }
    default:
      throw new UsageError(`unknown command "${head}"`);
  }
}
