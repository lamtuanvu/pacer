// Isolated TS fallback peer for native HTTP conformance tests. No service startup,
// agent, credential, config or installer paths are exercised.
import { handleV3 } from "../../src/api/http";
import type { Ctx } from "../../src/types";
import { readCoreSecrets, scrubCoreSecrets } from "../../src/core-secrets";
const home = process.env.PACER_HOME;
if (!home || process.env.HOME !== home) throw Error("isolated home required");
const token = scrubCoreSecrets(process.env) ? readCoreSecrets().internalToken : undefined;
const ctx = { pacerHome: home, env: {}, now: 1000 } as Ctx;
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(req) {
    if (req.headers.get("authorization") !== `Bearer ${token}`)
      return new Response(null, { status: 401 });
    return handleV3(req, { getCtx: () => ctx, tailMs: 10 });
  },
});
console.log(JSON.stringify({ internal: { port: server.port } }));
// The parent owns this peer. EOF retires it even if its listener has open streams.
for await (const _ of Bun.stdin.stream()) { /* ownership pipe */ }
server.stop(true);
