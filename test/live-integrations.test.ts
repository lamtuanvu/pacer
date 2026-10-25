import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { liveRoot, saveSession, type Session } from "../scripts/live/core";
import { integrationsFixtureRoot } from "../scripts/live/integrations";
import { main } from "../scripts/live/cli";
import { refusal } from "../scripts/live/guard";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function session(): Session {
  const id = `integrations-test-${crypto.randomUUID()}`, root = join(liveRoot, id);
  mkdirSync(join(root, "evidence"), { recursive: true, mode: 0o700 }); roots.push(root);
  const value = { id, root, port: 49901, pid: 1, createdAt: new Date().toISOString() };
  saveSession(value); return value;
}
test("integration fixtures require canonical unseeded active sandbox ownership", () => {
  const s = session(); expect(integrationsFixtureRoot(s)).toBe(join(s.root, "integrations"));
  for (const changed of [{ ...s, root: `${s.root}/..` }, { ...s, seed: "ui" as const }, { ...s, stopped: true }]) expect(() => integrationsFixtureRoot(changed)).toThrow();
  const outside = `${s.root}-outside`; mkdirSync(outside); roots.push(outside);
  rmSync(s.root, { recursive: true }); symlinkSync(outside, s.root);
  expect(() => integrationsFixtureRoot(s)).toThrow();
});
test("ordinary guard refuses integration writes and fixture accepts no overrides", async () => {
  expect(refusal(["integrations", "refresh"])).toContain("D3");
  for (const args of [["uninstall", "codex#work"], ["uninstall", "--all", "--yes", "--json"]]) expect(refusal(args)).toContain("D3");
  for (const args of [["integrations"], ["integrations", "--id", "missing", "--app", "/outside"], ["integrations", "--id", "missing", "--", "install"], ["integrations", "--id", "missing", "arbitrary"]]) await expect(main(args)).rejects.toThrow();
});
