import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { publish } from "../src/link/publish";
import { latestPath, outboxPath, pluginDataDir } from "../src/link/paths";
import { currentSnapshot, readOutboxSince } from "../src/link/store";
import { writeManifest } from "../src/install/manifest";
const b = { v: 1 as const, type: "budget" as const, data: { generatedAt: 1, strategy: "s", planner: "p", mode: "normal", providers: [], ranked: [] } };
const t = { v: 1 as const, type: "task" as const, data: { id: "t", state: "running", goal: "g", executor: null, backend: null, worktree: null, updatedAt: 1 } };
test("publish sequences outbox and persists current snapshot", async () => {
  const c = fakeCtx(); const first = await publish(c, [b, t], { bridge: false, channel: false }); expect(first.seq).toBe(2); expect(first.transports).toEqual(["outbox"]);
  expect(readFileSync(outboxPath(c), "utf8").trim().split("\n").map(x => JSON.parse(x).seq)).toEqual([1, 2]);
  expect(JSON.parse(readFileSync(latestPath(c), "utf8")).tasks).toHaveLength(1); const second = await publish(c, [t], { bridge: false, channel: false }); expect(second.seq).toBe(3); expect(readOutboxSince(c, 1).map(x => x.seq)).toEqual([2, 3]);
});
test("outbox rotation keeps the last 200 records", async () => {
  const c = fakeCtx(); const entries = Array.from({ length: 210 }, (_, i) => ({ seq: i + 1, envelope: { v: 1 as const, type: "alert" as const, data: { key: `k${i}`, level: "info" as const, title: "x".repeat(2000), body: "", at: i } } }));
  const { appendOutbox } = await import("../src/link/store"); appendOutbox(c, entries); expect(readFileSync(outboxPath(c), "utf8").trim().split("\n")).toHaveLength(200);
});
test("bridge skips missing plugin record and writes when installed", async () => {
  const c = fakeCtx(); expect((await publish(c, [b], { platform: "darwin", channel: false })).transports).toEqual(["outbox"]);
  writeManifest(c, { version: 1, planners: { "orca-plugin": { planner: "orca-plugin", installedAt: 1, pacerArgv: [], files: [], commands: [], notes: [] } } });
  const r = await publish(c, [b], { platform: "darwin", channel: false }); expect(r.transports).toContain("bridge"); expect(JSON.parse(readFileSync(join(pluginDataDir(c, "darwin"), "storage.json"), "utf8")).link.seq).toBe(2);
});
test("channel errors preserve successful transports", async () => {
  const c = fakeCtx({ run: async (argv) => argv[1] === "agent-context" ? ({ code: 0, stdout: '{"commands":[{"path":["plugin","send"]}]}', stderr: "" }) : ({ code: 1, stdout: "", stderr: "channel unavailable" }) }); writeManifest(c, { version: 1, planners: { "orca-plugin": { planner: "orca-plugin", installedAt: 1, pacerArgv: [], files: [], commands: [], notes: [] } } });
  const r = await publish(c, [b], { platform: "darwin" }); expect(r.transports).toContain("outbox"); expect(r.transports).toContain("bridge"); expect(r.errors).toHaveLength(1);
});
test("current snapshot includes only a live console and pid", () => {
  const c = fakeCtx(); mkdirSync(join(c.pacerHome, "link"), { recursive: true }); const p = join(c.pacerHome, "link", "console.json");
  writeFileSync(p, JSON.stringify({ handle: "h", paneKey: null, pid: 1, startedAt: c.now, heartbeatAt: c.now })); expect(currentSnapshot(c, () => true).console?.handle).toBe("h"); expect(currentSnapshot(c, () => false).console).toBeNull();
  writeFileSync(p, JSON.stringify({ handle: "h", paneKey: null, pid: 1, startedAt: c.now, heartbeatAt: c.now - 31 })); expect(currentSnapshot(c, () => true).console).toBeNull();
});
