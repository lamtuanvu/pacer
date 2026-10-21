import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { liveRoot, saveSession, type Session } from "../scripts/live/core";
import { rollbackProbe, updaterFixtureRoot } from "../scripts/live/updater";
import { main } from "../scripts/live/cli";
import { refusal } from "../scripts/live/guard";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function session(): Session {
  const id = `updater-test-${randomUUID()}`;
  const root = join(liveRoot, id);
  mkdirSync(root, { recursive: true, mode: 0o700 }); roots.push(root);
  const value: Session = { id, root, seed: "ui", port: 49901, pid: 1, createdAt: new Date().toISOString() };
  mkdirSync(join(root, "evidence"), { mode: 0o700 });
  saveSession(value); return value;
}
test("updater fixture stays inside the canonical seeded live sandbox", () => {
  const s = session(); expect(updaterFixtureRoot(s)).toBe(join(s.root, "updater"));
  expect(() => updaterFixtureRoot({ ...s, root: join(s.root, "..") })).toThrow();
  expect(() => updaterFixtureRoot({ ...s, seed: undefined })).toThrow();
  expect(() => updaterFixtureRoot({ ...s, stopped: true })).toThrow();
});
test("updater fixture refuses symlinked sandbox directories", () => {
  const s = session(); const target = `${s.root}-target`;
  mkdirSync(target, { mode: 0o700 }); roots.push(target);
  rmSync(s.root, { recursive: true }); symlinkSync(target, s.root);
  expect(() => updaterFixtureRoot(s)).toThrow();
});
test("updater command accepts only an explicit id, never paths, URLs or commands", async () => {
  for (const args of [["updater"], ["updater", "--id", "missing", "--base", "http://localhost"], ["updater", "--id", "missing", "--app", "/outside"], ["updater", "--id", "missing", "--", "update"], ["updater", "--id", "missing", "arbitrary"]]) {
    await expect(main(args)).rejects.toThrow();
  }
  expect(refusal(["update", "--no-restart", "--no-reinstall"])).toContain("D3");
});

test("updater refuses an evidence symlink before writing outside the sandbox", () => {
  const s = session(); const target = join(s.root, "outside-log");
  writeFileSync(target, "unchanged", { mode: 0o600 });
  symlinkSync(target, join(s.root, "evidence/log.jsonl"));
  expect(() => updaterFixtureRoot(s)).toThrow("evidence");
  expect(readFileSync(target, "utf8")).toBe("unchanged");
});
test("rollback failure probe quotes paths and removes only its own known staged file", async () => {
  const s = session(); const front = join(s.root, "pacer's fixture");
  writeFileSync(front, "untouched", { mode: 0o700 });
  writeFileSync(`${front}.new`, rollbackProbe(front), { mode: 0o700 });
  const child = Bun.spawn([`${front}.new`, "--version"], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  expect((await new Response(child.stdout).text()).trim()).toBe("pacer 0.0.2");
  expect(existsSync(`${front}.new`)).toBe(false);
  expect(readFileSync(front, "utf8")).toBe("untouched");
});
