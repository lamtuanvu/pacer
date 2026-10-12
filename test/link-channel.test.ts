import { expect, test } from "bun:test";
import { fakeCtx } from "./helpers";
import { detectChannel, channelArgv, sendChannel } from "../src/link/channel";
import { fakeRun, raw } from "./fixtures/orca/fake";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { refreshBridge, publish } from "../src/link/publish";
import { writeConsole, readLatest, readOutboxSince } from "../src/link/store";
import { pluginDataDir } from "../src/link/paths";
import { writeManifest } from "../src/install/manifest";
const env = { v: 1 as const, type: "alert" as const, data: { key: "x", level: "info" as const, title: "t", body: "b", at: 1 } };
test("agent context detection is cached for an hour", async () => {
  const f = fakeRun([[ ["orca", "agent-context"], raw(await import("node:fs").then(({readFileSync}) => readFileSync("test/fixtures/link/agent-context-1.4.224.json", "utf8"))) ]]); const c = fakeCtx({ run: f.run });
  expect(await detectChannel(c)).toBe(false); expect(await detectChannel(c)).toBe(false); expect(f.calls).toHaveLength(1);
});
test("plugin send fixture enables channel, argv matches proposed shape and missing Orca skips", async () => {
  const { readFileSync } = await import("node:fs"); const f = fakeRun([[ ["orca", "agent-context"], raw(readFileSync("test/fixtures/link/agent-context-with-plugin-send.json", "utf8")) ]]); expect(await detectChannel(fakeCtx({ run: f.run }))).toBe(true);
  expect(channelArgv(env)).toEqual(["orca", "plugin", "send", "pacer.pacer", "--data", JSON.stringify(env), "--json"]);
  const missing = fakeRun([]); const c = fakeCtx({ which: () => null, run: missing.run }); expect(await detectChannel(c)).toBe(false); expect(missing.calls).toHaveLength(0);
});
test("refreshBridge rewrites console heartbeat without changing latest or outbox", async () => {
  const c = fakeCtx();
  try {
    expect(refreshBridge(c, "darwin")).toBe("skipped");
    writeManifest(c, { version: 1, planners: { "orca-plugin": { planner: "orca-plugin", installedAt: 1, pacerArgv: [], files: [], commands: [], notes: [] } } });
    await publish(c, [env], { bridge: false, channel: false });
    const latest = readLatest(c), outbox = readOutboxSince(c, 0);
    const console = {handle:"term",paneKey:null,pid:process.pid,startedAt:c.now,heartbeatAt:c.now};
    writeConsole(c, console);
    expect(refreshBridge(c, "darwin")).toBe("written");
    const file = join(pluginDataDir(c, "darwin"), "storage.json");
    expect(JSON.parse(readFileSync(file, "utf8")).link).toEqual({...latest, serviceInstalled:false, console, consoles:[console], strategies:[{name:"default",active:false,summary:"Invalid or missing strategy",description:""}]});
    const later = {...c, now:c.now + 10};
    writeConsole(later, {...console, heartbeatAt:later.now});
    expect(refreshBridge(later, "darwin")).toBe("written");
    expect(JSON.parse(readFileSync(file, "utf8")).link.console.heartbeatAt).toBe(later.now);
    writeConsole(later, null);
    expect(refreshBridge(later, "darwin")).toBe("written");
    expect(JSON.parse(readFileSync(file, "utf8")).link.console).toBeNull();
    expect(readLatest(c)).toEqual(latest); expect(readOutboxSince(c, 0)).toEqual(outbox);
  } finally { rmSync(c.home, {recursive:true,force:true}); }
});
test("send failure caches unavailable state", async () => {
  const c = fakeCtx({ run: async () => ({ code: 1, stdout: "", stderr: "no send" }) });
  await expect(sendChannel(c, env)).rejects.toThrow("exited 1"); const cached = await import("../src/fsutil").then(m => m.readJson<any>(`${c.pacerHome}/link/channel.json`)); expect(cached.available).toBe(false);
});
