import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { currentUnitText, MARKER, restartAfterUpdate, serviceBackend, servicePath, unit, type ServiceDeps } from "../src/service";
import { fakeCtx } from "./helpers";

function linux() {
  const calls: string[][] = [];
  const ctx = fakeCtx({ env: { PATH: "/bin:/usr/bin", PACER_BIN: "/opt/pacer" }, which: () => null, run: async argv => { calls.push(argv); return { code: 0, stdout: "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=456\nExecMainStatus=0\n", stderr: "" }; } });
  const path = servicePath(ctx, "linux"); mkdirSync(dirname(path), { recursive: true });
  const d: ServiceDeps = { platform: "linux", uid: 501, argv: ["/opt/pacer"], waitMs: 0 };
  return { ctx, calls, path, d };
}
const older = (text: string) => text.replace("KillMode=process\n", "");

test("the generated unit stops only the service process when systemd restarts it", () => {
  const { ctx } = linux();
  const text = unit(ctx, ["/opt/pacer"]);
  expect(text).toContain("Restart=always\nRestartSec=10\nKillMode=process\n");
  expect(currentUnitText(text)).toBe(text);
});

test("restart rewrites an older unit and reloads systemd first; a current unit is only restarted", async () => {
  const { ctx, calls, path, d } = linux();
  writeFileSync(path, older(unit(ctx, ["/opt/pacer"])));
  await serviceBackend(ctx, d).restart();
  expect(readFileSync(path, "utf8")).toBe(unit(ctx, ["/opt/pacer"]));
  expect(calls).toEqual([["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "restart", "pacer-serve.service"]]);
  calls.length = 0;
  await serviceBackend(ctx, d).restart();
  expect(calls).toEqual([["systemctl", "--user", "restart", "pacer-serve.service"]]);
});

test("pacer update migrates the unit through the same restart", async () => {
  const { ctx, calls, path, d } = linux();
  writeFileSync(path, older(unit(ctx, ["/opt/pacer"])));
  expect(await restartAfterUpdate(ctx, "/opt/pacer", d)).toBe(true);
  expect(readFileSync(path, "utf8")).toContain("KillMode=process");
  expect(calls.map(c => c[2])).toEqual(["daemon-reload", "restart"]);
});

test("another KillMode value is replaced and a handwritten unit is left alone", () => {
  const managed = `# ${MARKER}\n[Service]\nExecStart="/opt/pacer" "serve"\nKillMode=control-group\nRestart=always\nRestartSec=10\n`;
  expect(currentUnitText(managed)).toBe(`# ${MARKER}\n[Service]\nExecStart="/opt/pacer" "serve"\nRestart=always\nRestartSec=10\nKillMode=process\n`);
  const handwritten = "[Service]\nExecStart=/opt/pacer serve\n";
  expect(currentUnitText(handwritten)).toBe(handwritten);
});
