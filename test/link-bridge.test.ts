import { expect, test, spyOn } from "bun:test";
import * as fs from "node:fs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { writeBridge, clearBridge, writePluginSetting } from "../src/link/bridge";
import { pluginDataDir, orcaUserDataDir } from "../src/link/paths";
import { writeManifest } from "../src/install/manifest";
import { emptySnapshot } from "../src/link/envelope";
const install = (c: ReturnType<typeof fakeCtx>) => writeManifest(c, { version: 1, planners: { "orca-plugin": { planner: "orca-plugin", installedAt: 1, pacerArgv: [], files: [], commands: [], notes: [] } } });
test("bridge removes its temporary file when rename fails and preserves the original", () => {
  const c = fakeCtx(); install(c);
  const file = join(pluginDataDir(c, "darwin"), "storage.json");
  mkdirSync(pluginDataDir(c, "darwin"), {recursive:true});
  writeFileSync(file, '{"other":"preserved"}');
  const rename = spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("rename failed"); });
  try {
    expect(() => writeBridge(c, emptySnapshot(), "darwin")).toThrow("rename failed");
    expect(readFileSync(file, "utf8")).toBe('{"other":"preserved"}');
    expect(fs.existsSync(`${file}.pacer-${process.pid}.tmp`)).toBe(false);
  } finally { rename.mockRestore(); fs.rmSync(c.home, {recursive:true,force:true}); }
});
test("bridge preserves keys, refuses malformed data byte-for-byte, caps values and clears only its key", () => {
  const c = fakeCtx(); install(c); const f = join(pluginDataDir(c, "darwin"), "storage.json"); mkdirSync(join(pluginDataDir(c, "darwin")), { recursive: true }); writeFileSync(f, '{"other":1}');
  expect(writeBridge(c, emptySnapshot(), "darwin")).toBe("written"); expect(JSON.parse(readFileSync(f, "utf8")).other).toBe(1); expect(clearBridge(c, "darwin")).toBe("cleared"); expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ other: 1 });
  writeFileSync(f, "{bad"); expect(String(writeBridge(c, emptySnapshot(), "darwin"))).toContain("refusing to overwrite"); expect(readFileSync(f, "utf8")).toBe("{bad");
  expect(String(writeBridge(c, { ...emptySnapshot(), alerts: [{ key: "x", level: "info", title: "x".repeat(300000), body: "", at: 1 }] }, "darwin"))).toContain("exceeds");
});
test("plugin settings write and malformed settings throw", () => { const c = fakeCtx(); const f = join(pluginDataDir(c, "darwin"), "settings.json"); writePluginSetting(c, "x", 1, "darwin"); expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ x: 1 }); writeFileSync(f, "bad"); expect(() => writePluginSetting(c, "x", 2, "darwin")).toThrow("refusing to overwrite"); });
test("Orca data directory honors platform defaults and overrides within temp home", () => {
  const c = fakeCtx(); const checks: [NodeJS.Platform, Record<string,string|undefined>, string][] = [["darwin", {}, join(c.home,"Library","Application Support","orca")],["linux",{XDG_CONFIG_HOME:join(c.home,"cfg")},join(c.home,"cfg","orca")],["linux",{},join(c.home,".config","orca")],["win32",{APPDATA:join(c.home,"Roaming")},join(c.home,"Roaming","orca")]];
  for (const [p,env,want] of checks) { const got = orcaUserDataDir({ home: c.home, env }, p); expect(got).toBe(want); expect(got.startsWith(c.home)).toBe(true); }
  expect(orcaUserDataDir({ home: c.home, env: { PACER_ORCA_USER_DATA: join(c.home,"custom") } }, "linux")).toBe(join(c.home,"custom"));
});
