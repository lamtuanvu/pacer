import { Server } from "node:net";

// Child-process fixture: refuse before any socket can bind, not after a probe
// happens to miss a short-lived listener. No production server is replaced.
const attempts: string[] = [];
const refuse = (kind: string): never => {
  attempts.push(kind);
  throw Error(`serve-help fixture refused ${kind}`);
};
Bun.serve = (() => refuse("Bun.serve")) as typeof Bun.serve;
Server.prototype.listen = (() => refuse("Server.listen")) as typeof Server.prototype.listen;
globalThis.Worker = new Proxy(globalThis.Worker, {
  construct: () => refuse("Worker"),
});
process.on("exit", () => process.stderr.write(`serve-help-listeners:${JSON.stringify(attempts)}\n`));
// Delayed module availability must not be mistaken for a running service.
if (process.env.PACER_TEST_DELAY_IMPORT === "1") await Bun.sleep(1250);
