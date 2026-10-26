import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli";
import { startServer } from "../src/serve/http";
import { fakeCtx } from "./helpers";

test("limits refresh calls the selected service and prints each account outcome", async () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  cursor: {usage: reactive}\n");
  const service = startServer(() => ctx, { port: 0, listener: false, pumpMs: 0 });
  try {
    ctx.env.PACER_PORT = String(service.port);
    const result = await main(["limits", "refresh", "cursor", "--json"], ctx);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ accounts: [{ account: "cursor", outcome: "unsupported" }] });
  } finally { await service.stop(); }
});
