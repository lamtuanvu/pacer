import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { pluginRegistry } from "../src/plugins";
import { probeHosts, remoteExclusion } from "../src/remote/eligibility";
import { remoteEligibilityFixture } from "./fixtures/remote-eligibility";

test("routing reachability uses the bundled fixed-script caller and caches its result", async () => {
  const { ctx, log, strategy, setDown } = remoteEligibilityFixture();
  expect(await remoteExclusion(ctx, strategy, "codex@box")).toBeNull();
  expect(readFileSync(log, "utf8")).toContain("BatchMode=yes");
  expect(readFileSync(log, "utf8")).toContain("ConnectTimeout=10");
  expect(await remoteExclusion(ctx, strategy, "codex@box")).toBeNull();
  expect(readFileSync(log, "utf8").match(/BatchMode=yes/g)).toHaveLength(1);
  setDown("box-ssh");
  expect(await probeHosts(ctx)).toEqual([{ alias: "box", reachable: false, failures: 1 }]);
});

test("disabled remote caller and SSH provider never fall back to direct SSH", async () => {
  for (const id of ["pacer-remote-caller", "pacer-ssh"]) {
    const { ctx, log, strategy } = remoteEligibilityFixture();
    await pluginRegistry(ctx).disable(ctx, id);
    expect(await remoteExclusion(ctx, strategy, "codex@box")).toBe(id === "pacer-ssh" ? "SSH host runner plugin pacer-ssh is disabled" : "SSH remote caller plugin pacer-remote-caller is disabled");
    expect(await probeHosts(ctx)).toEqual([{ alias: "box", reachable: false, failures: 0 }]);
    expect(existsSync(log)).toBe(false);
  }
});

test("a fresh healthy cache never keeps routing after either plugin is disabled", async () => {
  for (const id of ["pacer-remote-caller", "pacer-ssh"]) {
    const { ctx, log, strategy } = remoteEligibilityFixture();
    expect(await remoteExclusion(ctx, strategy, "codex@box")).toBeNull();
    await pluginRegistry(ctx).disable(ctx, id);
    expect(await remoteExclusion(ctx, strategy, "codex@box")).toContain(`plugin ${id} is disabled`);
    expect(await probeHosts(ctx)).toEqual([{ alias: "box", reachable: false, failures: 0 }]);
    expect(readFileSync(log, "utf8").match(/BatchMode=yes/g)).toHaveLength(1);
  }
});

test("a stale routing host snapshot cannot probe a replacement target", async () => {
  const { ctx, log, strategy, setTarget } = remoteEligibilityFixture();
  setTarget("replacement-ssh");
  expect(await remoteExclusion(ctx, strategy, "codex@box")).toBe("host box unreachable");
  expect(existsSync(log)).toBe(false);
});

test("reachability cannot name an unconfigured SSH alias", async () => {
  const { ctx, log } = remoteEligibilityFixture();
  await expect(pluginRegistry(ctx).call(ctx, "pacer-remote-caller", "remoteCaller.reachability",
    { alias: "other" }, { deadlineMs: 30_000 })).rejects.toMatchObject({ code: "not_found" });
  expect(existsSync(log)).toBe(false);
});
