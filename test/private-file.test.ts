import { afterEach, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateAppend, privateCreate, privateTouch, privateWrite } from "../src/private-file";
import { writeJsonAtomic } from "../src/fsutil";
import { atomicStrategyWrite } from "../src/config/edit";
import { writeEndpointState } from "../src/endpoints/state";
import { appendActivity } from "../src/activity/log";
import { fakeCtx } from "./helpers";
import { writeNative } from "../src/plugins/write-native";

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

test("private writers reject symlinked parent directories without changing their targets", () => {
  const root = mkdtempSync(join(tmpdir(), "pacer-private-")); roots.push(root);
  const outside = join(root, "outside"); mkdirSync(outside, { mode: 0o777 }); chmodSync(outside, 0o777);
  symlinkSync(outside, join(root, "state"));
  for (const write of [() => privateWrite(join(root, "state", "value"), "x"), () => privateAppend(join(root, "state", "log"), "x")]) expect(write).toThrow();
  expect(statSync(outside).mode & 0o777).toBe(0o777);
  expect(readdirSync(outside)).toEqual([]);
});

test("append and touch reject symlinked leaves without modifying their targets", () => {
  const root = mkdtempSync(join(tmpdir(), "pacer-private-")); roots.push(root);
  const target = join(root, "outside"); writeFileSync(target, "original"); chmodSync(target, 0o644);
  const link = join(root, "log"); symlinkSync(target, link);
  expect(() => privateAppend(link, "X")).toThrow();
  expect(() => privateTouch(link)).toThrow();
  expect(readFileSync(target, "utf8")).toBe("original");
  expect(statSync(target).mode & 0o777).toBe(0o644);
});

test("append and touch reject hard-linked leaves without modifying their targets", () => {
  const root = mkdtempSync(join(tmpdir(), "pacer-private-")); roots.push(root);
  const outside = join(root, "outside"), file = join(root, "log");
  writeFileSync(outside, "original"); chmodSync(outside, 0o644); linkSync(outside, file);
  const before = statSync(outside);
  expect(() => privateAppend(file, "X")).toThrow();
  expect(() => privateTouch(file)).toThrow();
  expect(readFileSync(outside, "utf8")).toBe("original");
  expect(statSync(outside).mode & 0o777).toBe(0o644);
  expect(statSync(outside).mtimeMs).toBe(before.mtimeMs);
});

test("parent swap during descriptor traversal is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "pacer-private-")); roots.push(root);
  const state = join(root, "state"), outside = join(root, "outside");
  mkdirSync(state); mkdirSync(outside, { mode: 0o777 }); chmodSync(outside, 0o777);
  const native = writeNative(), original = native.openAt;
  let swapped = false;
  native.openAt = function(fd, name, flags, mode) {
    if (!swapped && name === "state") {
      swapped = true;
      renameSync(state, join(root, "previous"));
      symlinkSync(outside, state);
    }
    return original(fd, name, flags, mode);
  };
  try { expect(() => privateAppend(join(state, "log"), "X")).toThrow(); }
  finally { native.openAt = original; }
  expect(swapped).toBe(true);
  expect(readdirSync(outside)).toEqual([]);
  expect(statSync(outside).mode & 0o777).toBe(0o777);
});

test("a directory swapped for a symlink between writes is rechecked", () => {
  const root=mkdtempSync(join(tmpdir(),"pacer-private-")); roots.push(root);
  const dir=join(root,"state"), outside=join(root,"outside");
  privateAppend(join(dir,"log"),"first");
  mkdirSync(outside,{mode:0o777}); chmodSync(outside,0o777);
  const previous=join(root,"previous");
  renameSync(dir,previous);
  symlinkSync(outside,dir);
  expect(()=>privateAppend(join(dir,"log"),"second")).toThrow();
  expect(readFileSync(join(previous,"log"),"utf8")).toBe("first");
  expect(statSync(outside).mode & 0o777).toBe(0o777);
});

test("seeded file-state matrix preserves append and touch confinement", () => {
  const root=mkdtempSync(join(tmpdir(),"pacer-private-")); roots.push(root);
  let seed=0x5ec70001;
  const next=()=>{ seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed; };
  for(let i=0;i<48;i++) {
    const dir=join(root,String(i)); mkdirSync(dir);
    const outside=join(dir,"outside"), file=join(dir,"file");
    const kind=next()%5, action=next()%2;
    if(kind===1) { writeFileSync(file,"old"); chmodSync(file,0o644); }
    if(kind===2) { writeFileSync(outside,"outside"); chmodSync(outside,0o644); symlinkSync(outside,file); }
    if(kind===3) { writeFileSync(outside,"outside"); chmodSync(outside,0o644); linkSync(outside,file); }
    if(kind===4) mkdirSync(file);
    const operation=()=>action===0 ? privateAppend(file,"X") : privateTouch(file);
    if(kind>=2) {
      expect(operation).toThrow();
      if(kind===2||kind===3) {
        expect(readFileSync(outside,"utf8")).toBe("outside");
        expect(statSync(outside).mode&0o777).toBe(0o644);
      }
    } else {
      operation();
      expect(readFileSync(file,"utf8")).toBe((kind===1?"old":"")+(action===0?"X":""));
      expect(statSync(file).mode&0o777).toBe(0o600);
      expect(statSync(dir).mode&0o777).toBe(0o700);
    }
  }
});
