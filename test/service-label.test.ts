import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { plist, serviceBackend, servicePath, LABEL, type ServiceDeps } from "../src/service";
import { fakeCtx } from "./helpers";

const fixtureLabel = "com.pacer.live.0123456789abcdef0123456789abcdef.service";
const goodFetch = (async () => Response.json({ ok: true, pid: 456 }, { headers: { "X-Pacer": "1" } })) as NonNullable<ServiceDeps["fetch"]>;
function mac(label?: string) {
  const calls: string[][] = [];
  const ctx = fakeCtx({ env: { PATH: "/bin:/usr/bin", PACER_BIN: "/opt/pacer" }, which: () => null, run: async argv => { calls.push(argv); return { code: 0, stdout: "service = {\n state = running\n pid = 456\n last exit code = 0\n}\n", stderr: "" }; } });
  return { ctx, calls, d: { platform: "darwin", uid: 501, argv: ["/opt/pacer"], fetch: goodFetch, waitMs: 0, ...(label ? { label } : {}) } as ServiceDeps };
}

test("a release build keeps the real launchd label", () => {
  const { ctx } = mac();
  expect(plist(ctx, ["/opt/pacer"])).toContain(`<key>Label</key><string>${LABEL}</string>`);
});

test("the plist and every launchctl target use the service label", async () => {
  const { ctx, calls, d } = mac(fixtureLabel);
  expect(plist(ctx, ["/opt/pacer"], fixtureLabel)).toContain(`<key>Label</key><string>${fixtureLabel}</string>`);
  const backend = serviceBackend(ctx, d);
  await backend.install();
  expect(readFileSync(servicePath(ctx, "darwin"), "utf8")).toContain(`<string>${fixtureLabel}</string>`);
  await backend.restart();
  const targeted = calls.filter(c => c[0] === "launchctl" && ["print", "bootout", "kickstart"].includes(c[1]));
  expect(targeted.length).toBeGreaterThan(0);
  expect(targeted.every(c => c.at(-1) === `gui/501/${fixtureLabel}`)).toBe(true);
  expect(calls.filter(c => c[0] === "launchctl" && c[1] !== "bootstrap").flat().some(arg => arg.endsWith(`/${LABEL}`))).toBe(false);
});
