import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Session } from "../scripts/live/core";
import { liveTestCheckout } from "./live-checkout";
import { main } from "../scripts/live/cli";
import { refusal } from "../scripts/live/guard";

const checkout = liveTestCheckout();
const { liveRoot } = await import(`${checkout}/scripts/live/core.ts`) as typeof import("../scripts/live/core");
const { repairFixtureRoot } = await import(`${checkout}/scripts/live/core-repair.ts`) as typeof import("../scripts/live/core-repair");

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function session(): Session {
  const id = `repair-test-${randomUUID()}`;
  const root = join(liveRoot, id);
  mkdirSync(join(root, "evidence"), { recursive: true, mode: 0o700 }); roots.push(root);
  return { id, root, seed: "ui", port: 49902, pid: 1, createdAt: new Date().toISOString() };
}
test("repair fixture requires an owned, active, canonical seeded sandbox", () => {
  const s = session();
  expect(repairFixtureRoot(s)).toBe(join(s.root, "repair"));
  expect(() => repairFixtureRoot({ ...s, root: `${s.root}/..` })).toThrow();
  expect(() => repairFixtureRoot({ ...s, seed: undefined })).toThrow();
  expect(() => repairFixtureRoot({ ...s, stopped: true })).toThrow();
  const target = `${s.root}-target`;
  mkdirSync(target, { mode: 0o700 }); roots.push(target);
  rmSync(s.root, { recursive: true }); symlinkSync(target, s.root);
  expect(() => repairFixtureRoot(s)).toThrow();
});
test("repair harness accepts only a sandbox id and cannot authorize ordinary updates", async () => {
  for (const args of [["repair"], ["repair", "--id", "missing", "--base", "http://127.0.0.1"], ["repair", "--id", "missing", "--app", "/outside"], ["repair", "--id", "missing", "--", "self-repair"], ["repair", "--id", "missing", "arbitrary"]]) {
    await expect(main(args)).rejects.toThrow();
  }
  expect(refusal(["update", "--no-restart", "--no-reinstall"])).toContain("D3");
  expect(refusal(["self-repair"])).not.toBeNull();
});
