import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { fakeCtx } from "./helpers";

const golden = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/routing-get.json"), "utf8"));
const strategies = {
  basic: '# comment\naccounts:\n  personal: {kind: claude}\n  codex: {kind: codex}\nplanner: claude-code\nrouting:\n  - default: [codex] # rule\npacing: {order: [codex], policy: priority}\n',
  kinds: 'accounts:\n  personal: {kind: claude}\n  codex: {kind: codex}\nplanner: claude-code\nrouting:\n  - kinds: [docs, tests]\n    executors: [codex]\n  - default: [claude-code]\n',
  alias: 'accounts:\n  team: {kind: codex}\nplanner: codex#team\nrouting:\n  - default: [codex#team]\n',
};

for (const [name, yaml] of Object.entries(strategies)) test(`TypeScript routing.get ${name} golden`, async () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), yaml);
  expect(await callOp(ctx, "routing.get", {})).toEqual(golden[name]);
});

test("TypeScript rejects account names outside the runner id grammar", async () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), 'accounts: {téam: {kind: codex}}\nplanner: codex#téam\nrouting: [{default: [codex#téam]}]\n');
  await expect(callOp(ctx, "routing.get", {})).rejects.toThrow();
});
