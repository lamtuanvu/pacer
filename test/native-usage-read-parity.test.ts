import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CoreError, PluginReportedError } from "../src/core/errors";
import { loadStrategy, type ProviderCfg } from "../src/config/strategy";
import { usageCallSpec, usageReadExtension } from "../src/plugins/usage-broker";
import { NETWORK_ENV } from "../src/plugins/capability-spawn";
import { fakeCtx, cleanupTestTmp } from "./helpers";
import type { Ctx, UsageReading } from "../src/types";

// B12-4: the private `usage.read` extension call. Rust (pacer-status) sends a
// spec it derived itself; this adapter re-derives the same spec from the host
// state and refuses any difference. The goldens it records are replayed by
// `crates/status/tests/usage.rs`. Re-record with UPDATE_M3_GOLDENS=1.

const NOW = 1_798_000_000;
const FIXTURE = join(import.meta.dir, "fixtures", "m3", "status", "usage-spec.json");
const HOMES: string[] = [];
afterAll(() => { for (const p of HOMES.splice(0)) rmSync(p, { recursive: true, force: true }); });
afterAll(cleanupTestTmp);

function host(opts: { env?: Record<string, string>; yaml?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "m3-usage-read-"));
  HOMES.push(root);
  const home = root;
  const pacerHome = join(home, ".pacer");
  mkdirSync(pacerHome, { recursive: true });
  mkdirSync(join(pacerHome, "cache"), { recursive: true });
  mkdirSync(join(home, "accounts", "team"), { recursive: true });
  mkdirSync(join(home, ".claude", "state", "budget"), { recursive: true });
  const orcaRoot = join(home, "orca");
  mkdirSync(join(orcaRoot, "codex-accounts", "team", "home"), { recursive: true });
  writeFileSync(join(pacerHome, "strategy.yaml"), opts.yaml ?? [
    "accounts:",
    "  claude: {kind: claude}",
    '  codex: {kind: codex, home: "~/accounts/team"}',
    "planner: claude-code",
    "routing:",
    "  - default: [claude-code]",
    "",
  ].join("\n"));
  const env: Record<string, string> = {
    HOME: home,
    PATH: "/usr/bin:/bin",
    TMPDIR: "/tmp",
    LANG: "en_US.UTF-8",
    XDG_CONFIG_HOME: join(home, ".config"),
    ORCA_USER_DATA_PATH: orcaRoot,
    CODEX_HOME: join(home, "accounts", "team"),
    PACER_PORT: "50910",
    OLLAMA_HOST: "http://127.0.0.1:50911",
    LMS_API_SERVER_INFO_PATH: "/tmp/pacer-lms-server.json",
    ...Object.fromEntries(NETWORK_ENV.map(key => [key, "proxy.example.invalid"])),
    ...opts.env,
  };
  const ctx = fakeCtx({ home, pacerHome, now: NOW, env });
  return { ctx, home, pacerHome, orcaRoot };
}

const cfg = (over: Partial<ProviderCfg> = {}): ProviderCfg => ({
  id: "claude-code", via: null, model: null, usage: "quota", allowPaid: false,
  cooldownS: 21600, quotaSource: null, weeklyTokens: null, weeklyUsd: null, ...over,
});

/** Replace a host's temp paths with stable tokens so the golden holds no machine path. */
function scrub(value: unknown, home: string, pacerHome: string): unknown {
  return JSON.parse(JSON.stringify(value)
    .replaceAll(JSON.stringify(pacerHome), JSON.stringify("{{PACER_HOME}}"))
    .replaceAll(JSON.stringify(home), JSON.stringify("{{HOME}}"))
    .replaceAll(pacerHome, "{{PACER_HOME}}")
    .replaceAll(home, "{{HOME}}"));
}

type FakeRegistry = {
  find: (ctx: Ctx, point: string, predicate: (c: any) => boolean) => string | null;
  call: (ctx: Ctx, id: string, method: string, params: unknown, options?: unknown) => Promise<unknown>;
};
const plugin = "pacer-usage";
const reading: UsageReading = { windows: [{ name: "7d", usedPct: 20, resetsAt: null, lengthS: 604800, paced: false }], capturedAt: NOW - 10, stale: false, source: "status-line" };
function registry(over: Partial<FakeRegistry> = {}): FakeRegistry {
  return { find: () => plugin, call: async () => reading, ...over };
}

function body(ctx: Ctx, name: string | null, conf: ProviderCfg, refresh = false) {
  const strategy = loadStrategy(ctx);
  const account = name === null ? undefined : strategy.accounts[name];
  const spec = usageCallSpec(ctx, conf, account, refresh);
  if ("reading" in spec) throw Error("fixture must produce a plugin spec");
  return {
    account: name,
    cfg: conf,
    refresh,
    spec: { params: spec.params, resources: spec.resources, accountHome: spec.accountHome },
  };
}

test("usageCallSpec goldens match the Rust usage_call_spec port", () => {
  const { ctx, home, pacerHome, orcaRoot } = host();
  const strategy = loadStrategy(ctx);
  const cases: { name: string; input: unknown; expected: unknown }[] = [];
  const record = (name: string, account: unknown, conf: ProviderCfg, refresh = false) => {
    const spec = usageCallSpec(ctx, conf, account as any, refresh);
    if ("reading" in spec) throw Error(`${name}: fixture must produce a plugin spec`);
    cases.push({
      name,
      input: scrub({ home, pacerHome, now: ctx.now, env: ctx.env, account,
        cfg: conf, refresh, readOnly: ctx.readOnly === true, entries: [{ id: plugin, bundled: true, state: "ready",
          manifest: { contributes: { usage: { providers: ["claude-code", "codex", "arkcli", "metered"] } } } }] }, home, pacerHome),
      expected: scrub(spec, home, pacerHome),
    });
    // The Orca fixture root is also a temp path; keep the golden token stable.
    cases[cases.length - 1].input = JSON.parse(JSON.stringify(cases[cases.length - 1].input).replaceAll(orcaRoot, "{{HOME}}/orca"));
    cases[cases.length - 1].expected = JSON.parse(JSON.stringify(cases[cases.length - 1].expected).replaceAll(orcaRoot, "{{HOME}}/orca"));
  };
  record("claude-default", strategy.accounts.claude, cfg());
  record("claude-named", { ...strategy.accounts.claude, name: "work", source: "pacer", home: join(home, "work") }, cfg({ id: "claude-code" }));
  record("codex-orca", { ...strategy.accounts.codex, source: "orca", orcaAccount: "team" }, cfg({ id: "codex" }), true);
  record("arkcli", { ...strategy.accounts.claude, name: "plan", kind: "endpoint", source: "opencode", quotaSource: "arkcli" } as any,
    cfg({ id: "plan", usage: "quota", quotaSource: "arkcli" }));
  record("metered-with-model", { ...strategy.accounts.claude, name: "api", kind: "endpoint", source: "opencode", usage: "metered" } as any,
    cfg({ id: "api", usage: "metered", model: "public/code" }));
  const text = JSON.stringify(cases, null, 2) + "\n";
  if (process.env.UPDATE_M3_GOLDENS === "1") writeFileSync(FIXTURE, text);
  expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(cases);
});

test("a matching usage.read spec returns the plugin reading", async () => {
  const { ctx } = host();
  const calls: unknown[] = [];
  const reg = registry({ call: async (_c, id, method, params, options) => {
    calls.push({ id, method, params, options });
    return reading;
  } });
  const reply = await usageReadExtension(ctx, plugin, body(ctx, "claude", cfg()), reg as any);
  expect(reply).toEqual({ reading });
  expect(calls).toHaveLength(1);
  expect((calls[0] as any).method).toBe("usage.read");
});

test("a changed resource path is refused", async () => {
  const { ctx } = host();
  const input = body(ctx, "claude", cfg()) as any;
  input.spec.resources.reads[0].path = "/etc/passwd";
  await expect(usageReadExtension(ctx, plugin, input, registry() as any))
    .rejects.toMatchObject({ code: "invalid_input", message: "usage resources differ from the host's" });
});

test("a clock outside five seconds is refused", async () => {
  const { ctx } = host();
  const input = body(ctx, "claude", cfg()) as any;
  input.spec.params.now = ctx.now + 10;
  await expect(usageReadExtension(ctx, plugin, input, registry() as any))
    .rejects.toMatchObject({ code: "invalid_input", message: "usage resources differ from the host's" });
});

test("a different plugin id is refused", async () => {
  const { ctx } = host();
  await expect(usageReadExtension(ctx, "another-plugin", body(ctx, "claude", cfg()), registry() as any))
    .rejects.toMatchObject({ code: "invalid_input", message: "usage plugin differs from the host's" });
});

test("unknown keys in the private body are refused", async () => {
  const { ctx } = host();
  const input = { ...body(ctx, "claude", cfg()), extra: 1 };
  await expect(usageReadExtension(ctx, plugin, input, registry() as any))
    .rejects.toMatchObject({ code: "invalid_input", message: "invalid private plugin request" });
});

test("a plugin error reply has no pacer code", async () => {
  const { ctx } = host();
  const reg = registry({ call: async () => { throw new PluginReportedError("invalid_input", "plugin broke"); } });
  expect(await usageReadExtension(ctx, plugin, body(ctx, "claude", cfg()), reg as any))
    .toEqual({ thrown: "CoreError: plugin broke", errorCode: null });
});

test("a host timeout keeps the pacer code", async () => {
  const { ctx } = host();
  const reg = registry({ call: async () => { throw new CoreError("plugin_timeout", "plugin call expired"); } });
  expect(await usageReadExtension(ctx, plugin, body(ctx, "claude", cfg()), reg as any))
    .toEqual({ thrown: "CoreError: plugin call expired", errorCode: "plugin_timeout" });
});
