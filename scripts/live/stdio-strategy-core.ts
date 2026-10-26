/** Fixed hello responder for the live strategy.list native-selection witness. */
import { createInterface } from "node:readline";

if (process.argv.slice(2).join(" ") !== "api --stdio") process.exit(2);

for await (const line of createInterface({ input: process.stdin })) {
  if (line === '{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":3}}') {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocol: "3.0.0", ops: ["strategy.list", "strategy.show"] } }) + "\n");
  } else if (line === '{"jsonrpc":"2.0","id":2,"method":"strategy.list","params":{}}') {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { forwardedToFixedCore: true } }) + "\n");
  } else if (line === '{"jsonrpc":"2.0","id":2,"method":"strategy.show","params":{"name":"research"}}') {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { forwardedToFixedCore: true } }) + "\n");
  } else process.exit(2);
}
