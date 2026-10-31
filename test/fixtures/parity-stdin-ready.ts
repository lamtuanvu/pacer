/** Observe the real CLI's instance stdin-consumer boundary without consuming input. */
import { realpathSync } from "node:fs";
import { join } from "node:path";

const cli = realpathSync(join(import.meta.dir, "../../src/cli.ts"));
const argv = [cli, "api", "--stdio"];
if (Bun.main !== cli || JSON.stringify(process.argv.slice(1)) !== JSON.stringify(argv)) {
  throw Error("parity preload requires the actual CLI entry and api --stdio argv");
}
const stdin = process.stdin;
const original = stdin[Symbol.asyncIterator];
const descriptor = Object.getOwnPropertyDescriptor(stdin, Symbol.asyncIterator);
Object.defineProperty(stdin, Symbol.asyncIterator, {
  configurable: true,
  value: function (this: typeof stdin) {
    if (this !== stdin) throw Error("unexpected parity stdin receiver");
    const iterator = original.call(this);
    // Restore this instance immediately; the iterator and all bytes are untouched.
    if (descriptor) Object.defineProperty(stdin, Symbol.asyncIterator, descriptor);
    else delete (stdin as Partial<typeof stdin>)[Symbol.asyncIterator];
    process.stderr.write(JSON.stringify({ type: "pacer-parity-ready", main: Bun.main, argv: process.argv.slice(1) }) + "\n");
    return iterator;
  },
});
