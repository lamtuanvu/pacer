import { expect, test } from "bun:test";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { orcaUserDataDir } from "../src/link/paths";
test("Orca data directory honors platform defaults and overrides within temp home", () => {
  const c = fakeCtx(); const checks: [NodeJS.Platform, Record<string,string|undefined>, string][] = [["darwin", {}, join(c.home,"Library","Application Support","orca")],["linux",{XDG_CONFIG_HOME:join(c.home,"cfg")},join(c.home,"cfg","orca")],["linux",{},join(c.home,".config","orca")],["win32",{APPDATA:join(c.home,"Roaming")},join(c.home,"Roaming","orca")]];
  for (const [p,env,want] of checks) { const got = orcaUserDataDir({ home: c.home, env }, p); expect(got).toBe(want); expect(got.startsWith(c.home)).toBe(true); }
  expect(orcaUserDataDir({ home: c.home, env: { PACER_ORCA_USER_DATA: join(c.home,"custom") } }, "linux")).toBe(join(c.home,"custom"));
});
