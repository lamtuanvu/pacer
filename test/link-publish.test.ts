import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, statSync } from "node:fs";
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
test("publication files and existing link state are private", async () => {
  const c = fakeCtx();
  const dir = join(c.pacerHome, "link");
  mkdirSync(dir, { recursive: true, mode: 0o777 });
  chmodSync(dir, 0o777);
  writeFileSync(outboxPath(c), "", { mode: 0o666 });
  chmodSync(outboxPath(c), 0o666);
  writeFileSync(latestPath(c), "{}", { mode: 0o666 });
  chmodSync(latestPath(c), 0o666);
  expect((await publish(c, [b])).errors).toEqual([]);
  for (const [path, mode] of [[dir, 0o700], [outboxPath(c), 0o600], [latestPath(c), 0o600]] as const)
    expect(statSync(path).mode & 0o777).toBe(mode);
});
test("outbox rotation keeps the last 1000 records", async () => {
  const c = fakeCtx(); const entries = Array.from({ length: 1010 }, (_, i) => ({ seq: i + 1, envelope: { type: "alert" as const, data: { key: `k${i}`, level: "info" as const, title: "x".repeat(2000), body: "", at: i } } }));
  const { appendOutbox } = await import("../src/link/store"); appendOutbox(c, entries); expect(readFileSync(outboxPath(c), "utf8").trim().split("\n")).toHaveLength(1000);
  expect(statSync(outboxPath(c)).mode & 0o777).toBe(0o600);
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
