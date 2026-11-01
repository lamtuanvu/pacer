import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, chmodSync, linkSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { publish } from "../src/link/publish";
import { latestPath, outboxPath, pluginDataDir } from "../src/link/paths";
import { currentSnapshot, readOutboxSince } from "../src/link/store";
import { writeManifest } from "../src/install/manifest";
const b = { type: "budget" as const, data: { generatedAt: 1, strategy: "s", planner: "p", mode: "normal", providers: [], ranked: [] } };
const t = { type: "task" as const, data: { id: "t", state: "running", goal: "g", executor: null, backend: null, worktree: null, updatedAt: 1 } };
test("publish sequences outbox and persists current snapshot", async () => {
  const c = fakeCtx(); const first = await publish(c, [b, t]); expect(first.seq).toBe(2); expect(first.transports).toEqual(["outbox"]);
  expect(readFileSync(outboxPath(c), "utf8").trim().split("\n").map(x => JSON.parse(x).seq)).toEqual([1, 2]);
  expect(JSON.parse(readFileSync(latestPath(c), "utf8")).tasks).toHaveLength(1); const second = await publish(c, [t]); expect(second.seq).toBe(3); expect(readOutboxSince(c, 1).map(x => x.seq)).toEqual([2, 3]);
});
test("outbox rotation keeps the last 1000 records", async () => {
  const c = fakeCtx(); const entries = Array.from({ length: 1010 }, (_, i) => ({ seq: i + 1, envelope: { type: "alert" as const, data: { key: `k${i}`, level: "info" as const, title: "x".repeat(2000), body: "", at: i } } }));
  const { appendOutbox } = await import("../src/link/store"); appendOutbox(c, entries); expect(readFileSync(outboxPath(c), "utf8").trim().split("\n")).toHaveLength(1000);
});
test("outbox append and rotation keep private modes and refuse hard-linked leaves", async () => {
  const c = fakeCtx();
  const { appendOutbox } = await import("../src/link/store");
  const entries = Array.from({ length: 1001 }, (_, i) => ({ seq: i + 1, envelope: { type: "alert" as const, data: { key: `k${i}`, level: "info" as const, title: "x", body: "", at: i } } }));
  appendOutbox(c, entries);
  expect(statSync(outboxPath(c)).mode & 0o777).toBe(0o600);
  expect(statSync(join(outboxPath(c), "..")).mode & 0o777).toBe(0o700);
  const outside = join(c.pacerHome, "outside");
  writeFileSync(outside, "original"); chmodSync(outside, 0o644);
  const file = outboxPath(c);
  const { unlinkSync } = await import("node:fs"); unlinkSync(file); linkSync(outside, file);
  expect(() => appendOutbox(c, entries.slice(0, 1))).toThrow();
  expect(readFileSync(outside, "utf8")).toBe("original");
  expect(statSync(outside).mode & 0o777).toBe(0o644);
});
test("entity envelopes stay in the outbox even when the channel is available", async () => {
  const calls: string[][] = [];
  const c = fakeCtx({run:async argv=>{calls.push(argv);return {code:0,stdout:'{"commands":[{"path":["plugin","send"]}]}',stderr:""};}});
  const entity = {type:"entity" as const,data:{kind:"counts" as const,id:"counts",value:{running:1}}};
  writeManifest(c,{version:1,planners:{"orca-plugin":{planner:"orca-plugin",installedAt:1,pacerArgv:[],files:[],commands:[],notes:[]}}});
  await publish(c,[b]);
  const storage=join(pluginDataDir(c),"storage.json");
  expect(existsSync(storage)).toBe(false);
  const report = await publish(c,[entity]);
  expect(report.transports).toEqual(["outbox"]);
  expect(calls).toEqual([]);
  expect(existsSync(storage)).toBe(false);
  expect(readOutboxSince(c,1)[0]?.envelope).toEqual({type:entity.type,data:entity.data});
  await publish(c,[entity,b]);
  expect(calls).toEqual([]);
});
test("current snapshot keeps recent console registrations with live pids", () => {
  const c = fakeCtx(); mkdirSync(join(c.pacerHome, "link"), { recursive: true }); const p = join(c.pacerHome, "link", "console.json");
  writeFileSync(p, JSON.stringify({ handle: "h", paneKey: null, pid: 1, startedAt: c.now, heartbeatAt: c.now })); expect(currentSnapshot(c, () => true).console?.handle).toBe("h"); expect(currentSnapshot(c, () => false).console).toBeNull();
  writeFileSync(p, JSON.stringify({ handle: "h", paneKey: null, pid: 1, startedAt: c.now, heartbeatAt: c.now - 31 })); expect(currentSnapshot(c, () => true).console?.handle).toBe("h");
});
