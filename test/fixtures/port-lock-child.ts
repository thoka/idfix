/**
 * A child process for test/port-lock.test.ts. It reserves one port pair in
 * the lock folder of its arguments, prints the port, and holds the locks
 * until its stdin closes. The exit releases the locks.
 */
import { reservePortPair } from "../port-lock";

const [dir, first, last] = process.argv.slice(2);
const pair = await reservePortPair({ dir: dir ?? "", range: { first: Number(first), last: Number(last) } });
process.stdout.write(`${pair.port}\n`);
for await (const _ of Bun.stdin.stream()) {
  // Hold the locks until the parent closes stdin.
}
