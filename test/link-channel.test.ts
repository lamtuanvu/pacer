import { expect, test } from "bun:test";
import { fakeCtx } from "./helpers";
import { detectChannel, channelArgv, sendChannel } from "../src/link/channel";
import { fakeRun, raw } from "./fixtures/orca/fake";
const env = { v: 1 as const, type: "alert" as const, data: { key: "x", level: "info" as const, title: "t", body: "b", at: 1 } };
test("agent context detection is cached for an hour", async () => {
  const f = fakeRun([[ ["orca", "agent-context"], raw(await import("node:fs").then(({readFileSync}) => readFileSync("test/fixtures/link/agent-context-1.4.224.json", "utf8"))) ]]); const c = fakeCtx({ run: f.run });
  expect(await detectChannel(c)).toBe(false); expect(await detectChannel(c)).toBe(false); expect(f.calls).toHaveLength(1);
});
test("plugin send fixture enables channel, argv matches proposed shape and missing Orca skips", async () => {
  const { readFileSync } = await import("node:fs"); const f = fakeRun([[ ["orca", "agent-context"], raw(readFileSync("test/fixtures/link/agent-context-with-plugin-send.json", "utf8")) ]]); expect(await detectChannel(fakeCtx({ run: f.run }))).toBe(true);
  expect(channelArgv(env)).toEqual(["orca", "plugin", "send", "pacer.pacer", "--data", JSON.stringify(env), "--json"]);
  const c = fakeCtx({ which: () => null }); expect(await detectChannel(c)).toBe(false);
});
test("send failure caches unavailable state", async () => {
  const c = fakeCtx({ run: async () => ({ code: 1, stdout: "", stderr: "no send" }) });
  await expect(sendChannel(c, env)).rejects.toThrow("exited 1"); const cached = await import("../src/fsutil").then(m => m.readJson<any>(`${c.pacerHome}/link/channel.json`)); expect(cached.available).toBe(false);
});
