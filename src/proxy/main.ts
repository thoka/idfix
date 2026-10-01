/**
 * CLI entry of the cost proxy:
 * `bun src/proxy/main.ts --port 4097 [--hostname 127.0.0.1] [--upstream URL] [--deepinfra-upstream URL]`
 *
 * `oc-sub up` starts the committed bundle of this entry
 * (`opencode/cost-proxy/cost-proxy.js`) next to the server.
 */
import { DEFAULT_DEEPINFRA_UPSTREAM, DEFAULT_UPSTREAM, startProxy } from "./proxy";

function argOf(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const port = Number(argOf("--port") ?? "4097");
const hostname = argOf("--hostname") ?? "127.0.0.1";
const upstream = argOf("--upstream");
const deepinfraUpstream = argOf("--deepinfra-upstream");

const server = startProxy({ port, hostname, upstream, deepinfraUpstream });
console.log(
  JSON.stringify({
    source: "oc-sub-cost-proxy",
    event: "listening",
    time: new Date().toISOString(),
    hostname: server.hostname,
    port: server.port,
    upstream: upstream ?? DEFAULT_UPSTREAM,
    deepinfraUpstream: deepinfraUpstream ?? DEFAULT_DEEPINFRA_UPSTREAM,
  }),
);
