import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { recordStatusLine, statusLineGoldenPath } from "../scripts/golden/status-line";
import { recordServeAuth, serveAuthGoldenPath } from "../scripts/golden/serve-auth";

// The Rust front door is tested against these recordings; they must match today's TypeScript.
test("status-line goldens match the TypeScript renderer (re-record: bun scripts/golden/status-line.ts)", () => {
  expect(JSON.parse(JSON.stringify(recordStatusLine()))).toEqual(JSON.parse(readFileSync(statusLineGoldenPath, "utf8")));
});

test("serve auth goldens match the Bun server's statuses and refusals (re-record: bun scripts/golden/serve-auth.ts)", async () => {
  // Forwarded 200 bodies (hello, health) are the core's own answers; the Rust test checks statuses and refusal bodies.
  const shape = (rows: Record<string, unknown>[]) => rows.map(r => ({ name: r.name, status: r.status, body: r.status === 200 ? undefined : r.body }));
  expect(shape(await recordServeAuth())).toEqual(shape(JSON.parse(readFileSync(serveAuthGoldenPath, "utf8"))));
});
