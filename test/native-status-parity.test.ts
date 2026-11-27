import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadStrategy, validateStrategy } from "../src/config/strategy";
import { accountEvidenceScope } from "../src/evidence/scope";
import { computeStatus } from "../src/engine/status";
import { pluginRegistry, shutdownPlugins } from "../src/plugins";
import type { ActivityProfile } from "../src/pace/activity";
import type { Ctx, UsageReading } from "../src/types";
import goldens from "./fixtures/engine/goldens.json";
import { cleanupTestTmp, fakeCtx } from "./helpers";

// B12-5: native computeStatus parity over disposable fixture homes. Each home is
// built twice at the same path (TS first, then Rust after a clean rebuild), so
// absolute paths in a fixture cannot become a source of drift. Both sides get
// the same readings, profile and plugin registry snapshot, and the post-call
// file trees are compared byte for byte.

const NOW = 1_798_000_000;
const ROOT = join(import.meta.dir, "..");
const TARGET = join(ROOT, "target");
const BINARY = join(process.env.CARGO_TARGET_DIR ?? TARGET, "debug", "examples", "status_probe");
const HOMES: string[] = [];
const PROFILE: ActivityProfile = {
  ...(goldens.pace[0].input.profile as ActivityProfile),
  days: 7,
};
const ACTIVE: ActivityProfile = goldens.pace[0].input.profile as ActivityProfile;

beforeAll(() => {
  execFileSync("cargo", ["build", "-q", "-p", "pacer-status", "--example", "status_probe", "--locked"], {
    cwd: ROOT,
    env: { ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? TARGET },
  });
});
afterAll(() => {
  for (const home of HOMES.splice(0)) rmSync(home, { recursive: true, force: true });
  cleanupTestTmp();
});

type Options = {
  readOnly?: boolean;
  cacheOnly?: boolean;
  includePlannerSignIn?: boolean;
  servicePath?: boolean;
  profile?: ActivityProfile | null;
};

type Spec = {
  name: string;
  strategy: Record<string, unknown>;
  readings?: Record<string, UsageReading>;
  files?: Record<string, unknown>;
  env?: Record<string, string>;
  options?: Options;
  check?: (status: any) => void;
};

const iso = (value: unknown): string => JSON.stringify(value);
const put = (home: string, relative: string, value: unknown) => {
  const path = join(home, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : iso(value));
};

const QUOTA = (over: Partial<UsageReading> = {}): UsageReading => ({
  windows: [{ name: "7d", usedPct: 20, resetsAt: NOW + 100_000, lengthS: 604_800, paced: false }],
  capturedAt: NOW - 60,
  stale: false,
  source: "status-line",
  ...over,
});
const EMPTY = (over: Partial<UsageReading> = {}): UsageReading => ({
  windows: [], capturedAt: null, stale: false, ...over,
});

function base(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "default",
    planner: { agent: "claude-code", account: "claude" },
    accounts: {
      claude: { name: "claude", kind: "claude", usage: "quota" },
      codex: { name: "codex", kind: "codex", usage: "quota" },
    },
    runners: {
      "claude-code": { agent: "claude-code", account: "claude", enabled: true },
      codex: { agent: "codex", account: "codex", enabled: true },
    },
    runnerAliases: {},
    hosts: {},
    pacing: {
      policy: "priority", order: ["codex", "claude-code"], accounts: "spread",
      aheadThreshold: 85, behindThreshold: 55, plannerReserve: 0, plannerReserveHeadroom: 0,
      plannerProbe: "off", fillThreshold: 80, balance: "off", plannerTierFallback: "on",
    },
    routing: [{ kinds: ["feature"], executors: ["codex", "claude-code"] }],
    ...over,
  };
}
const defaultReadings = (): Record<string, UsageReading> => ({ claude: QUOTA(), codex: QUOTA() });

/** Runner-scoped limit marks with the evidence scope `appliesTo` needs to see them. */
function limitFiles(strategy: Record<string, unknown>, runners: string[]): Record<string, unknown> {
  const validated = validateStrategy(strategy, "strategy.yaml");
  const identity = accountEvidenceScope(validated.accounts.claude, validated.hosts).identity;
  const marks: Record<string, number> = {};
  const evidence: Record<string, unknown> = {};
  for (const runner of runners) {
    marks[runner] = NOW + 1000;
    evidence[runner] = {
      observedAt: NOW - 10, until: NOW + 1000, manual: false,
      scope: { account: "claude", identity, runner, model: "default", host: runner.slice(runner.indexOf("@") + 1) },
    };
  }
  return {
    ".pacer/exhausted.json": marks,
    ".pacer/state/exhausted-evidence.json": evidence,
  };
}

/** Keep routing and pacing valid when a fixture replaces the runner set. */
function strategyWith(strategy: Record<string, unknown>): Record<string, unknown> {
  const runners = strategy.runners as Record<string, unknown> | undefined;
  if (!runners) return strategy;
  return { ...strategy, pacing: { ...(strategy.pacing as object), order: Object.keys(runners) } };
}

/** Build one fresh home. Paths come from `home`, so the same spec at the same path is identical. */
function build(spec: Spec, home: string): Ctx {
  mkdirSync(home, { recursive: true });
  HOMES.push(home);
  const pacerHome = join(home, ".pacer");
  mkdirSync(join(pacerHome, "state"), { recursive: true });
  mkdirSync(join(pacerHome, "cache"), { recursive: true });
  mkdirSync(join(home, "bin"), { recursive: true });
  for (const bin of ["claude", "codex", "cursor", "agy", "opencode"]) {
    const path = join(home, "bin", bin);
    writeFileSync(path, `#!/bin/sh\nexit 0\n`);
    chmodSync(path, 0o755);
  }
  put(home, ".pacer/strategy.yaml", strategyWith(spec.strategy));
  for (const [name, content] of Object.entries(spec.files ?? {})) put(home, name, content);
  const env: Record<string, string> = {
    HOME: home,
    PATH: join(home, "bin"),
    TZ: "UTC",
    ORCA_USER_DATA_PATH: join(home, "orca"),
    PACER_ORCA_USER_DATA: join(home, "orca"),
    PACER_PORT: "50910",
    OLLAMA_HOST: "http://127.0.0.1:50911",
    ...spec.env,
  };
  return fakeCtx({
    home, pacerHome, now: NOW, env,
    readOnly: spec.options?.readOnly,
    which: (bin: string) => {
      const path = join(home, "bin", bin);
      return existsSync(path) ? path : null;
    },
  });
}

/** The same walk the Rust probe reports: `<octal mode> <base64 bytes>` per regular file. */
function filesOf(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        const relative = path.slice(root.length + 1).split("/").join("/");
        // The plugin registry's per-process orca link token is random, not shared state.
        if (relative === ".pacer/orca/link.lock") continue;
        out[relative] = `${(stat.mode & 0o777).toString(8).padStart(3, "0")} ${readFileSync(path).toString("base64")}`;
      }
    }
  };
  walk(root);
  return out;
}

type RustReply = {
  result?: { status: any; policy: any } | string;
  error?: string;
  files: Record<string, string>;
};
function probe(home: string, args: unknown, fn = "compute_status", env: Record<string, string> = {}): RustReply {
  const input = iso({ fn, home, now: NOW, env, args }) + "\n";
  const out = execFileSync(BINARY, { input, encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as RustReply;
}

async function parity(spec: Spec, useProfile: boolean) {
  const home = join(tmpdir(), `m3-status-${spec.name.replace(/[^a-z0-9]+/gi, "-")}-${useProfile ? "p" : "n"}`);
  rmSync(home, { recursive: true, force: true });
  const readings = spec.readings ?? defaultReadings();
  const profile = useProfile ? PROFILE : null;

  // Copy A: TypeScript.
  const a = build(spec, home);
  const strategy = loadStrategy(a);
  const options = { ...spec.options, profile, readings: new Map(Object.entries(readings)) };
  const ts = await computeStatus(a, strategy, options as never);
  const tsFiles = filesOf(home);
  await shutdownPlugins(a);
  rmSync(home, { recursive: true, force: true });

  // Copy B: Rust, from the same specification at the same path.
  const b = build(spec, home);
  const tsEntries = pluginRegistry(b).nativeSnapshot(b);
  await shutdownPlugins(b);
  const rust = probe(home, {
    strategyFrom: "active",
    options: { ...spec.options, profile },
    readings,
    entries: tsEntries,
  }, "compute_status", Object.fromEntries(Object.entries(b.env).filter((entry): entry is [string, string] => entry[1] !== undefined)));
  expect(rust.error).toBeUndefined();
  const result = rust.result as { status: any; policy: any };
  expect(result.status).toEqual(ts);
  expect(iso(result.status)).toBe(iso(ts)); // key order, and JS number spelling
  expect(result.policy).toEqual((ts as any).policy);
  expect(rust.files).toEqual(tsFiles);
  expect(iso(rust.files)).toBe(iso(tsFiles));
  spec.check?.(result.status);
}

const TWO_HOSTS = base({
  planner: { agent: "codex", account: "codex" },
  hosts: {
    h1: { ssh: "h1", accounts: { claude: { home: join(tmpdir(), "m3-status-host") } } },
    h2: { ssh: "h2", accounts: { claude: { home: join(tmpdir(), "m3-status-host") } } },
  },
  runners: {
    "claude-code@h1": { agent: "claude-code", account: "claude", host: "h1" },
    "claude-code@h2": { agent: "claude-code", account: "claude", host: "h2" },
    codex: { agent: "codex", account: "codex", enabled: true },
  },
  routing: [{ kinds: ["feature"], executors: ["codex", "claude-code@h1", "claude-code@h2"] }],
});

const cases: Spec[] = [
  {
    name: "quota-accounts",
    strategy: base(),
    readings: { claude: QUOTA(), codex: QUOTA({ windows: [{ name: "5h", usedPct: 65, resetsAt: NOW + 3600, lengthS: 18_000, paced: false }], source: "session-log" }) },
    check: (s) => {
      expect(s.accounts.map((a: any) => a.name)).toEqual(["claude", "codex"]);
      expect(s.providers.map((p: any) => p.id)).toEqual(["claude-code", "codex"]);
    },
  },
  {
    name: "planner-reserve",
    strategy: base({ pacing: { ...(base().pacing as object), plannerReserve: 20 } }),
    check: (s) => expect(s.accounts[0].usageState.windows.length).toBeGreaterThan(0),
  },
  {
    name: "error-with-last-good",
    strategy: base(),
    files: { ".pacer/state/usage/claude.json": QUOTA() },
    readings: {
      claude: QUOTA(),
      codex: QUOTA({ capturedAt: null, stale: true, error: "provider offline", windows: [] }),
    },
    check: (s) => {
      expect(s.accounts[1].stale).toBe(true);
      expect(s.accounts[1].usageState.error.message).toBe("provider offline");
    },
  },
  {
    name: "manual-exhausted",
    strategy: base(),
    files: {
      ".pacer/exhausted.json": { claude: NOW + 1000 },
      ".pacer/state/exhausted-evidence.json": { claude: { observedAt: NOW - 10, until: NOW + 1000, manual: true } },
    },
    check: (s) => {
      expect(s.accounts[0].verdict).toBe("EXHAUSTED");
      expect(s.accounts[0].usageState.figure.window).toBe("limit");
    },
  },
  {
    name: "one-runner-limited",
    strategy: TWO_HOSTS,
    files: limitFiles(TWO_HOSTS, ["claude-code@h1"]),
    check: (s) => {
      const account = s.accounts.find((a: any) => a.name === "claude");
      expect(account.usageState.blockedRunners.map((b: any) => b.runner)).toEqual(["claude-code@h1"]);
      expect(account.verdict).not.toBe("EXHAUSTED");
    },
  },
  {
    name: "both-runners-limited",
    strategy: TWO_HOSTS,
    files: limitFiles(TWO_HOSTS, ["claude-code@h1", "claude-code@h2"]),
    check: (s) => expect(s.accounts.find((a: any) => a.name === "claude").verdict).toBe("EXHAUSTED"),
  },
  {
    name: "reactive-and-unmetered",
    strategy: base({
      accounts: {
        claude: { name: "claude", kind: "claude", usage: "quota" },
        cursor: { name: "cursor", kind: "cursor", usage: "reactive" },
        agy: { name: "agy", kind: "agy", usage: "unmetered" },
      },
      runners: {
        "claude-code": { agent: "claude-code", account: "claude", enabled: true },
        cursor: { agent: "cursor", account: "cursor" },
        agy: { agent: "agy", account: "agy" },
      },
      routing: [{ kinds: ["feature"], executors: ["claude-code", "cursor", "agy"] }],
    }),
    readings: { claude: QUOTA(), cursor: EMPTY({ source: "reactive" }), agy: EMPTY({ source: "unmetered" }) },
    check: (s) => {
      const by = (name: string) => s.accounts.find((a: any) => a.name === name);
      expect(by("cursor").verdict).toBe("OK");
      expect(by("agy").verdict).toBe("UNMETERED");
      expect(by("cursor").usageState.observedAt).toBeNull();
    },
  },
  {
    name: "metered-spend",
    strategy: base({
      accounts: {
        claude: { name: "claude", kind: "claude", usage: "quota" },
        api: { name: "api", kind: "endpoint", source: "opencode", provider: "testprovider", usage: "metered", budget: { weekly_usd: 50 } },
      },
      runners: {
        "claude-code": { agent: "claude-code", account: "claude", enabled: true },
        "opencode#api": { agent: "opencode", account: "api", model: "testprovider/model" },
      },
      routing: [{ kinds: ["feature"], executors: ["claude-code", "opencode#api"] }],
    }),
    readings: { claude: QUOTA(), api: EMPTY({ spendUsd: 12.5, source: "metered" }) },
    check: (s) => expect(s.accounts.find((a: any) => a.name === "api").usageState.spend.usdWeek).toBe(12.5),
  },
  {
    name: "key-missing",
    strategy: base({
      accounts: {
        claude: { name: "claude", kind: "claude", usage: "quota" },
        api: {
          name: "api", kind: "endpoint", usage: "metered",
          connection: {
            api: "openai-compatible", base_url: "https://example.invalid/v1", key: "env:MISSING_KEY_FOR_PARITY",
            models: [{ id: "m", context: 1000, output: 1000, tools: true }],
          },
        },
      },
      runners: {
        "claude-code": { agent: "claude-code", account: "claude", enabled: true },
        "opencode#api": { agent: "opencode", account: "api" },
      },
      routing: [{ kinds: ["feature"], executors: ["claude-code", "opencode#api"] }],
    }),
    readings: { claude: QUOTA(), api: EMPTY({ source: "metered" }) },
    check: (s) => expect(s.providers.find((p: any) => p.account === "api").unavailableReason).toBe("Key missing"),
  },
  {
    name: "orca-folder-missing",
    strategy: base({
      accounts: {
        claude: { name: "claude", kind: "claude", usage: "quota" },
        codex: { name: "codex", kind: "codex", usage: "quota" },
        orca: { name: "orca", kind: "codex", usage: "quota", orca_account: "ghost" },
      },
      runners: {
        "claude-code": { agent: "claude-code", account: "claude", enabled: true },
        codex: { agent: "codex", account: "codex", enabled: true },
        "codex#orca": { agent: "codex", account: "orca" },
      },
      routing: [{ kinds: ["feature"], executors: ["claude-code", "codex", "codex#orca"] }],
    }),
    readings: { claude: QUOTA(), codex: QUOTA(), orca: QUOTA() },
    check: (s) => expect(s.providers.find((p: any) => p.account === "orca").unavailableReason).toBe("account folder not found"),
  },
  {
    name: "signed-out-codex",
    strategy: base(),
    check: (s) => expect(s.providers.find((p: any) => p.account === "codex").signedOutReason).toBeTypeOf("string"),
  },
  {
    name: "blocked-broken-alias",
    strategy: base({ runners: { ...(base().runners as object), cx: { agent: "codex", account: "codex" } } }),
    files: {
      ".pacer/blocked.json": { cx: { reason: "manual", until: NOW + 1000 } },
      ".pacer/broken.json": { cx: { reason: "crashed", until: NOW + 1000 } },
    },
    check: (s) => {
      const provider = s.providers.find((p: any) => p.id === "codex");
      expect(provider.blockedReason).toBe("manual");
      expect(provider.brokenReason).toBe("crashed");
    },
  },
  {
    name: "usage-source-orca-warning",
    strategy: base({ accounts: { claude: { name: "claude", kind: "claude", usage: "quota", usage_source: "orca" }, codex: { name: "codex", kind: "codex", usage: "quota" } } }),
    check: (s) => expect(s.warnings[0]).toContain("usage_source orca is no longer read; using native"),
  },
  {
    name: "pacer-off",
    strategy: base(),
    env: { PACER: "off" },
    check: (s) => expect(s.disabled).toBe(true),
  },
  {
    name: "mode-hold",
    strategy: base(),
    files: { ".pacer/state/mode-hold.json": { mode: "relaxed", until: NOW + 1000 } },
    check: (s) => expect(s.mode).toBe("relaxed"),
  },
  {
    name: "host-runner",
    strategy: base({
      hosts: { fakehost: { ssh: "fakehost", accounts: { codex: { home: join(tmpdir(), "m3-status-host") } } } },
      runners: { "claude-code": { agent: "claude-code", account: "claude", enabled: true }, "codex@fakehost": { agent: "codex", account: "codex", host: "fakehost" } },
      routing: [{ kinds: ["feature"], executors: ["claude-code", "codex@fakehost"] }],
    }),
    check: (s) => {
      const provider = s.providers.find((p: any) => p.account === "codex");
      expect(provider.installed).toBe(true);
      expect(provider.signedOutReason).toBeUndefined();
    },
  },
  {
    name: "read-only-cache-only",
    strategy: base(),
    options: { readOnly: true, cacheOnly: true },
    readings: {},
    check: (s) => expect(s.accounts.every((a: any) => a.stale)).toBe(true),
  },
  {
    name: "legacy-strategy",
    strategy: {
      name: "legacy",
      planner: "claude-code",
      providers: { "claude-code": { usage: "quota" }, codex: { usage: "quota" } },
      routing: [{ default: ["claude-code", "codex"] }],
    },
    readings: { "claude-code": QUOTA(), codex: QUOTA() },
    check: (s) => {
      expect(s.strategy).toBe("default");
      expect(s.providers.every((p: any) => !Object.hasOwn(p, "agent"))).toBe(true);
    },
  },
  {
    name: "policy-plugin-failing",
    strategy: base({
      plugins: {
        policy: { mode: "closed" },
        installed: { "fx-policy": { version: "1.0.0", capabilities: [] } },
      },
    }),
    files: {
      ".pacer/plugins/fx-policy/pacer-plugin.json": {
        id: "fx-policy", version: "1.0.0", publisher: "test", host: "^1.6", entry: "missing-main.ts",
        capabilities: [], contributes: { policy: {} },
      },
    },
    check: (s) => {
      expect(s.policy.mode).toBe("closed");
      expect(s.policy.plugins).toBe(1);
    },
  },
];

for (const spec of cases) {
  for (const useProfile of [true, false]) {
    test(`computeStatus parity: ${spec.name} (${useProfile ? "profile" : "null profile"})`, async () => {
      await parity(spec, useProfile);
    });
  }
}

test("the profile fixture carries a seven-day activity profile", () => {
  expect(PROFILE.days).toBe(7);
  expect(ACTIVE.days).toBeGreaterThanOrEqual(7);
});
