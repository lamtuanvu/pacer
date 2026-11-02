import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { recordSurfaces } from "../scripts/golden/session-surfaces";
test("CLI, terminal launch and HTTP session policy match TS golden", async () => {
  const path = new URL(
      "./fixtures/sessions/surfaces-parity.json",
      import.meta.url,
    ),
    rows = await recordSurfaces();
  if (process.env.UPDATE_SESSION_GOLDENS === "1")
    writeFileSync(path, JSON.stringify(rows, null, 2) + "\n");
  expect(rows).toEqual(JSON.parse(readFileSync(path, "utf8")));
}, 30000);
import { startServer } from "../src/serve/http";
import { fakeCtx } from "./helpers";
test("executor bearer can reach task session routes but cannot reach general terminal session routes", async () => {
  const ctx = fakeCtx({ env: { PACER_ROLE: "executor" } }),
    server = startServer(() => ctx, { port: 0, pumpMs: 0 });
  try {
    const headers = { authorization: `Bearer ${server.token}` },
      base = `http://127.0.0.1:${server.port}`;
    expect(
      (await fetch(base + "/v3/tasks/unknown/session", { headers })).status,
    ).toBe(404);
    expect(
      (
        await fetch(
          base + "/v3/terminals/00000000-0000-0000-0000-000000000000/session",
          { headers },
        )
      ).status,
    ).toBe(403);
  } finally {
    server.stop();
  }
});
