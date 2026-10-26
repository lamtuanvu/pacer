import {unavailableObservations} from "./fixtures/unavailable-observations";
import { unavailableFilesystem } from "./fixtures/unavailable-filesystem";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostClient } from "@pacer/plugin";
import { handlers, manifest as notifierManifest } from "../plugins/pacer-notify/index";
import { createCallAuthority, type CallAuthority } from "../src/plugins/authority";
import { prepareSpawnAuthority } from "../src/plugins/capability-spawn";
import { answerCapability } from "../src/plugins/host";
import { notifierResources } from "../src/plugins/notifier-resources";
import { manifestSchema, type PluginManifest } from "../src/plugins/protocol";
import { fakeCtx } from "./helpers";

interface Receipt { pid: number; argv: string[] }
const owners: CallAuthority[] = [];
const roots: string[] = [];
afterEach(async () => {
  try { await Promise.all(owners.splice(0).map(owner => owner.revoke())); }
  finally { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); }
});

function fixture(platform = "darwin", options: { missing?: boolean; hold?: boolean; grants?: string[]; scopes?: string[] } = {}) {
  const ctx = fakeCtx();
  roots.push(ctx.home);
  mkdirSync(ctx.pacerHome, { recursive: true });
  const binary = join(ctx.home, "owned-notifier");
  const receiptPath = join(ctx.home, "receipts.jsonl");
  const recorder = join(ctx.home, "recorder.js");
  const marker = join(ctx.home, "must-not-exist");
  // This executable only records arguments. It cannot show an OS notification.
  const source = `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({pid:process.pid,argv:process.argv.slice(3)}) + "\\n");
${options.hold ? "setTimeout(() => process.exit(0), 2000);" : "process.exit(0);"}
`;
  writeFileSync(recorder, source, { mode: 0o700 });
  // Bun consumes a leading script argument "--". A fixed sentinel makes the
  // recorder observe notify-send's separator too; quoted "$@" never reparses text.
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  writeFileSync(binary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(recorder)} fixture-sentinel "$@"\n`, { mode: 0o700 });
  const lookups: string[] = [];
  ctx.which = name => { lookups.push(name); return options.missing ? null : binary; };
  const title = `Title "quoted"\\\n$(touch ${marker})`;
  const body = `-body; touch ${marker}\n\`touch ${marker}\``;
  const resources = notifierResources(platform, title, body);
  const owner = createCallAuthority(ctx, resources, {
    grants: options.grants ?? ["process.spawn"], deadlineMs: Date.now() + 5000,
  });
  owners.push(owner);
  prepareSpawnAuthority(owner);
  const manifest: PluginManifest = manifestSchema.parse(notifierManifest);
  if (options.scopes) manifest.capabilities.find(capability => capability.name === "process.spawn")!.scopes = options.scopes;
  const plugin = { id: manifest.id, manifest, config: { platform } };
  const call = <T>(method: string, params: unknown = {}) => answerCapability(ctx, plugin, method, params, owner) as Promise<T>;
  const host: HostClient = { ...unavailableObservations, fs: unavailableFilesystem,
    call,
    config: async () => (await call<{ config: Record<string, unknown> }>("capability.config.get")).config,
    log: async (level, message) => { await call("capability.log", { level, message }); },
    http: async () => { throw new Error("unexpected network request"); },
    secrets: { present: async () => { throw new Error("unexpected secret lookup"); } },
  };
  const command = resources.commands[0];
  const receipts = (): Receipt[] => existsSync(receiptPath)
    ? readFileSync(receiptPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  return { ctx, owner, manifest, plugin, host, binary, marker, title, body, command, receipts, lookups,
    request: (params: unknown = command) => call<{ code: number; timedOut: boolean }>("capability.process.spawn", params) };
}

for (const platform of ["darwin", "linux"]) {
  test(`${platform} plugin vector matches host authority and delivers literal text through the actual broker`, async () => {
    const f = fixture(platform);
    expect(await handlers["notifier.deliver"]({ key: "owned", title: f.title, body: f.body, url: "/app/#/" }, f.host, f.owner.signal)).toEqual({ delivered: true });
    const expected = platform === "darwin"
      ? ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", f.title, f.body]
      : ["--", f.title, f.body];
    expect(f.receipts()).toHaveLength(1);
    expect(f.receipts()[0].argv).toEqual(expected);
    expect(existsSync(f.marker)).toBe(false);
    expect(f.lookups).toEqual([platform === "darwin" ? "osascript" : "notify-send"]);
  });
}

test("altered arguments, another declared tool, absolute paths and timeout escalation have no effects", async () => {
  const f = fixture();
  const argv = f.command!.argv;
  const variants = [
    [...argv.slice(0, -1), "changed body"],
    [...argv.slice(0, -2), "changed title", f.body],
    [...argv, "extra"],
    ["notify-send", "--", f.title, f.body],
    ["sh", "-c", f.title],
    [f.binary, ...argv.slice(1)],
    ["osascript", "-e", "display notification \"forged script\""],
  ];
  for (const changed of variants) await expect(f.request({ argv: changed, timeoutMs: 5000 })).rejects.toMatchObject({ code: "capability_denied" });
  await expect(f.request({ argv, timeoutMs: 5001 })).rejects.toMatchObject({ code: "capability_denied" });
  for (const override of [{ env: {} }, { cwd: f.ctx.home }, { stdin: "unapproved" }]) {
    await expect(f.request({ ...f.command, ...override })).rejects.toMatchObject({ code: "invalid_input" });
  }
  expect(f.receipts()).toEqual([]);
  expect((await f.request()).code).toBe(0);
  expect(f.receipts()).toHaveLength(1);
});

test("manifest declaration, captured grant and owning authority independently gate the same command", async () => {
  const outside = fixture("darwin", { scopes: ["notify-send"] });
  await expect(outside.request()).rejects.toMatchObject({ code: "capability_denied" });
  const ungranted = fixture("darwin", { grants: [] });
  await expect(ungranted.request()).rejects.toMatchObject({ code: "capability_denied" });
  const f = fixture();
  const undeclared = { ...f.plugin, manifest: { ...f.manifest, capabilities: [] } };
  await expect(answerCapability(f.ctx, undeclared, "capability.process.spawn", f.command, f.owner)).rejects.toMatchObject({ code: "capability_denied" });
  await expect(answerCapability(f.ctx, f.plugin, "capability.process.spawn", f.command)).rejects.toMatchObject({ code: "capability_denied" });
  expect([outside.receipts(), ungranted.receipts(), f.receipts()]).toEqual([[], [], []]);
});

test("missing tools and unsupported platforms cannot acquire notification effects", async () => {
  const missing = fixture("linux", { missing: true });
  expect(await missing.request()).toMatchObject({ code: 127, timedOut: false });
  expect(await handlers["notifier.deliver"]({ key: "missing", title: missing.title, body: missing.body, url: "" }, missing.host, missing.owner.signal)).toEqual({ delivered: false });
  const unsupported = fixture("win32");
  await expect(unsupported.request({ argv: ["notify-send", "--", unsupported.title, unsupported.body], timeoutMs: 5000 })).rejects.toMatchObject({ code: "capability_denied" });
  expect(unsupported.lookups).toEqual([]);
  expect([missing.receipts(), unsupported.receipts()]).toEqual([[], []]);
});

test("issuance pins the executable before the first notifier capability request", async () => {
  const f = fixture();
  renameSync(f.binary, f.binary + ".original");
  writeFileSync(f.binary, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(f.marker)}, "wrong executable");\n`, { mode: 0o700 });
  await expect(f.request()).rejects.toMatchObject({ code: "capability_denied" });
  expect(existsSync(f.marker)).toBe(false);
  expect(f.receipts()).toEqual([]);
});

test("revocation settles an owned notifier child and denies every later request", async () => {
  const f = fixture("linux", { hold: true });
  const running = f.request().then(value => ({ value }), error => ({ error }));
  const until = Date.now() + 1500;
  while (!f.receipts().length && Date.now() < until) await Bun.sleep(5);
  expect(f.receipts()).toHaveLength(1);
  const pid = f.receipts()[0].pid;
  await f.owner.revoke();
  const settled = await running;
  expect(settled).toHaveProperty("error");
  expect(() => process.kill(pid, 0)).toThrow();
  await expect(f.request()).rejects.toMatchObject({ code: "capability_denied" });
  expect(f.receipts()).toHaveLength(1);
});
