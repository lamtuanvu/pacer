import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "plugin.hello")
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: m.id,
        result: {
          protocol: "1.4.0",
          id: "sp06-rpc",
          version: "1.0.0",
          contributes: ["planner"],
          features: ["plannerInstallTransactions"],
        },
      }) + "\n",
    );
  else if (m.method === "planner.install")
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { finished: true } }) +
        "\n" +
        JSON.stringify({
          jsonrpc: "2.0",
          id: "late",
          method: "capability.planner.run",
          params: m.params.intent,
          _meta: m._meta,
        }) +
        "\n",
    );
});
