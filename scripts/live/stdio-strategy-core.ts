/** Fixed hello responder for bounded strategy and routing native-selection witnesses. */
import { createInterface } from "node:readline";

if (process.argv.slice(2).join(" ") !== "api --stdio") process.exit(2);

for await (const line of createInterface({ input: process.stdin })) {
  if (line === '{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":3}}') {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocol: "3.0.0", ops: ["strategy.list", "strategy.show", "strategy.use", "strategy.save", "routing.set"] } }) + "\n");
  } else if (line === '{"jsonrpc":"2.0","id":2,"method":"strategy.list","params":{}}') {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { forwardedToFixedCore: true } }) + "\n");
  } else if (line === '{"jsonrpc":"2.0","id":2,"method":"strategy.show","params":{"name":"research"}}') {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { forwardedToFixedCore: true } }) + "\n");
  } else if (line === '{"jsonrpc":"2.0","id":2,"method":"strategy.use","params":{"name":"research"}}') {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { forwardedToFixedCore: true } }) + "\n");
  } else if (line === '{"jsonrpc":"2.0","id":2,"method":"strategy.use","params":{"name":"default"}}') {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { forwardedToFixedCore: true } }) + "\n");
  } else if (line === '{"jsonrpc":"2.0","id":2,"method":"strategy.save","params":{"name":"new-plan","draft":{"from":"default"},"reason":"Fixed validation"}}') {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { forwardedToFixedCore: true } }) + "\n");
  } else if (line === '{"jsonrpc":"2.0","id":2,"method":"routing.set","params":{"rules":[{"executors":["codex","claude-code"]}]}}') {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { forwardedToFixedCore: true } }) + "\n");
  } else process.exit(2);
}
