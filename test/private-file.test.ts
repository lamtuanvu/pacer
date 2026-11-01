import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateAppend, privateCreate, privateTouch, privateWrite } from "../src/private-file";
import { writeJsonAtomic } from "../src/fsutil";
import { atomicStrategyWrite } from "../src/config/edit";
import { writeEndpointState } from "../src/endpoints/state";
import { appendActivity } from "../src/activity/log";
import { fakeCtx } from "./helpers";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

for (const mask of [0o022, 0o077]) {
  test(`private state writes under umask ${mask.toString(8)}`, () => {
    const old = process.umask(mask);
    try {
      const root = mkdtempSync(join(tmpdir(), "pacer-private-")); roots.push(root);
      const dir = join(root, "state"); mkdirSync(dir, { mode: 0o777 });
      const path = join(dir, "value.json");
      writeFileSync(path, "old", { mode: 0o666 }); chmodSync(path, 0o666);
      privateWrite(path, "new");
      expect(readFileSync(path, "utf8")).toBe("new");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(readdirSync(dir)).toEqual(["value.json"]);
      const inode = statSync(path).ino;
      privateAppend(path, "-tail");
      expect(readFileSync(path, "utf8")).toBe("new-tail");
      expect(statSync(path).ino).toBe(inode);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      privateTouch(join(dir, "marker"));
      expect(statSync(join(dir, "marker")).mode & 0o777).toBe(0o600);
      privateAppend(join(dir, "new.log"), "first\n");
      expect(statSync(join(dir, "new.log")).mode & 0o777).toBe(0o600);
      privateWrite(join(dir, "hook.sh"), "#!/bin/sh\n", 0o700);
      expect(statSync(join(dir, "hook.sh")).mode & 0o777).toBe(0o700);
      privateCreate(join(dir, "once.json"), "first");
      expect(statSync(join(dir, "once.json")).mode & 0o777).toBe(0o600);
      expect(() => privateCreate(join(dir, "once.json"), "second")).toThrow();
      expect(readFileSync(join(dir, "once.json"), "utf8")).toBe("first");
    } finally { process.umask(old); }
  });

  test(`representative writers enforce modes under umask ${mask.toString(8)}`, () => {
    const old = process.umask(mask);
    try {
      const ctx = fakeCtx();
      const state = join(ctx.pacerHome, "state", "generic.json");
      writeJsonAtomic(state, { ok: true });
      writeEndpointState(ctx, "local", { state: "not_tested" });
      const strategy = join(ctx.pacerHome, "strategy.yaml");
      privateWrite(strategy, "planner: codex\n");
      atomicStrategyWrite(strategy, "planner: claude-code\n");
      appendActivity(ctx, { kind: "config", level: "info", text: "mode check" });
      for (const file of [state, join(ctx.pacerHome, "endpoints", "state.json"), strategy, join(ctx.pacerHome, "state", "activity.jsonl")]) {
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(statSync(join(file, "..")).mode & 0o777).toBe(0o700);
      }
    } finally { process.umask(old); }
  });
}

test("stale temporary names do not block replacement and rename failure cleans up", () => {
  const root = mkdtempSync(join(tmpdir(), "pacer-private-")); roots.push(root);
  const target = join(root, "value");
  writeFileSync(`${target}.pacer-stale.tmp`, "stale");
  privateWrite(target, "complete");
  expect(readFileSync(target, "utf8")).toBe("complete");
  mkdirSync(join(root, "directory"));
  expect(() => privateWrite(join(root, "directory"), "failed")).toThrow();
  expect(readdirSync(root).filter(name => name.includes(".pacer-")).sort()).toEqual(["value.pacer-stale.tmp"]);
});
