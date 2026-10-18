import { expect, test } from "bun:test";
import { removableVolumeChecks } from "../src/install/removable-volume";
import { fakeCtx } from "./helpers";
const repo = ["", "Volumes", "External", "repo"].join("/");
test("non-macOS does not probe", async () => {
  expect(await removableVolumeChecks(fakeCtx({run: async () => { throw Error("unexpected"); }}), {platform:"linux", paths:[repo]})).toEqual([]);
});
for (const kind of ["timeout", "denied", "ok"] as const) {
  test(`removable volume ${kind} is bounded and reported`, async () => {
    const calls: string[][] = [];
    const ctx = fakeCtx({run: async (a, ms) => {
      calls.push(a); expect(ms).toBe(3000);
      if(a[0] === "/usr/bin/codesign") return {code:0, stdout:"", stderr:"Signature=adhoc"};
      return {code:kind === "ok" ? 0 : 1, stdout:"", stderr:kind === "denied" ? "Operation not permitted" : "", timedOut:kind === "timeout"};
    }});
    const checks = await removableVolumeChecks(ctx, {platform:"darwin", paths:[repo, "/tmp/local"], binary:"/tmp/pacer"});
    expect(calls).toHaveLength(2);
    expect(checks[0].level).toBe(kind === "ok" ? "ok" : "warn");
    if(kind !== "ok") expect(checks[0].fix).toContain("Privacy & Security");
    expect(checks[1].detail).toContain("each update");
  });
}
