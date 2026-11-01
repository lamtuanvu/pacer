import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./install-plugin-fixtures";
import { installLegacyPlugin } from "./helpers";
import { parseJsonc, setMember, removeMember } from "../src/install/jsonc";
import { applyUndo } from "../src/install/manifest";
import { init, agentPreview, agentConnect, agentDisconnect, doctor, pluginInstall, onboardingSkip } from "../src/core/setup";
import { checkSetup } from "../src/setup/check";
import { detectAgents } from "../src/install/detection";
import { uninstallPlugin } from "../src/plugin/install";
import { pluginCli } from "../src/plugin/cli";
import { readManifest, writeManifest } from "../src/install/manifest";
import { withVersionFixtures } from "./planner-detect-fixtures";
import { writeInstallFile } from "../src/install/atomic";
import { atomicStrategyWrite } from "../src/config/edit";
import { initCmd } from "../src/install/init";

// Captured from the current TS editor. These strings are byte goldens, including
// the BOM, CRLF, comments, trailing comma, and the exact undo result.
const before = '\uFEFF{\r\n  // retained\r\n  "mcp": {\r\n    "other": true,\r\n  },\r\n}\r\n';
const installed = '\uFEFF{\r\n  // retained\r\n  "mcp": {\n    "pacer": {\n      "command": "pacer",\n      "args": [\n        "mcp"\n      ]\n    },\r\n    "other": true,\r\n  },\r\n}\r\n';

test("JSONC insertion and recorded member undo keep exact TS bytes", () => {
  const actual = setMember(before, ["mcp", "pacer"], { command: "pacer", args: ["mcp"] });
  expect(actual).toBe(installed);
  expect(parseJsonc(actual)).toEqual({ mcp: { pacer: { command: "pacer", args: ["mcp"] }, other: true } });
  expect(removeMember(actual, ["mcp", "pacer"])).toBe(before);
  expect(applyUndo(actual, [{ kind: "json-member", path: ["mcp", "pacer"] }])).toBe(before);
  expect(applyUndo(actual, [{ kind: "json-member", path: ["mcp", "pacer"], dropEmpty: ["mcp"] }])).toBe(before);
  expect(applyUndo('{"mcp":{"pacer":{"command":"pacer"}},"keep":1}',
    [{ kind: "json-member", path: ["mcp", "pacer"], dropEmpty: ["mcp"] }])).toBe('{"keep":1}');
});

test("JSONC replacement, empty parent, duplicate key and refusal bytes", () => {
  expect(setMember('{\n  "a": 1 /* keep */,\n  "b": 2\n}\n', ["a"], { x: true }))
    .toBe('{\n  "a": {\n    "x": true\n  } /* keep */,\n  "b": 2\n}\n');
  expect(setMember("{}", ["a"], 1)).toBe('{\n  "a": 1\n}');
  expect(removeMember('{"a": 1, "b": 2,}', ["b"])).toBe('{"a": 1, }');
  expect(setMember('{"a": 1, "a": 2}', ["a"], 3)).toBe('{"a": 1, "a": 3}');
  expect(() => setMember('{"a": 1}', ["a", "b"], 2)).toThrow("parent must be an object");
  expect(() => setMember("{}", [], 1)).toThrow("member path must not be empty");
});

test("seeded structured JSON edits agree with parsing and undo bytes", () => {
  let seed = 0x571c0de;
  for (let index = 0; index < 64; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const original = { mcp: { other: { command: `other-${seed & 255}`, enabled: !!(seed & 256) } },
      keep: [seed, `quote: \"${seed >>> 8}\"`, null] };
    const text = `${JSON.stringify(original, null, seed & 1 ? 2 : 4)}\n`;
    const value = { command: "pacer", args: ["mcp", String(index)] };
    const edited = setMember(text, ["mcp", "pacer"], value);
    expect(parseJsonc(edited)).toEqual({ ...original, mcp: { ...original.mcp, pacer: value } });
    expect(removeMember(edited, ["mcp", "pacer"])).toBe(text);
  }
});

test("recorded TOML and JSON key undo retain exact TS bytes", () => {
  expect(applyUndo('[user]\nname = "kept"\n[pacer]\ncommand = "pacer"\n[next]\nx = 1\n',
    [{ kind: "toml-table", table: "pacer" }]))
    .toBe('[user]\nname = "kept"\n[next]\nx = 1\n');
  expect(applyUndo('{\n  "keep": 1,\n  "pacer": true\n}\n',
    [{ kind: "json-key", key: "pacer" }]))
    .toBe('{\n  "keep": 1\n}\n');
});

test("setup init and check characterize a disposable home", async () => {
  const ctx = fakeCtx({ which: () => null, env: { PACER_BIN: "pacer" } });
  const empty = await checkSetup(ctx, { snapshotProbe: false, deferStatus: true });
  expect(empty.items.find(item => item.id === "planner")?.status).toBe("pending");
  await expect(init(ctx, "unknown")).rejects.toMatchObject({ code: "invalid_input" });
  const result = await init(ctx, "codex");
  expect(result.strategy).toBe(join(ctx.pacerHome, "strategy.yaml"));
  expect(readFileSync(result.strategy, "utf8")).toBe('planner: codex\naccounts:\n  codex: { usage: quota, kind: codex }\n# To add opencode-go: use via: opencode, model: opencode-go/<model>,\n# usage: metered, and budget.weekly_tokens (e.g. budget: {weekly_tokens: 20M}).\npacing: {policy: priority, planner_reserve: 15, order: [ codex ]}\nrouting: []\n');
  expect(statSync(ctx.pacerHome).mode & 0o777).toBe(0o700);
  expect(statSync(result.strategy).mode & 0o777).toBe(0o600);
  const checked = await checkSetup(ctx, { snapshotProbe: false, deferStatus: true });
  expect(checked.items.find(item => item.id === "planner")?.detail).toContain("codex");
  expect(checked.integration).toEqual({ configuration: "unverified", invocation: "unverified" });
});

test("setup and install state tighten existing modes under both umasks", async () => {
  const originalUmask = process.umask();
  try {
    for (const mask of [0o022, 0o077]) {
      process.umask(mask);
      const ctx = fakeCtx({ which: () => null, env: { PACER_BIN: "pacer" } });
      mkdirSync(ctx.pacerHome, { recursive: true, mode: 0o755 });
      chmodSync(ctx.pacerHome, 0o755);
      const strategy = (await init(ctx, "codex")).strategy;
      expect(statSync(ctx.pacerHome).mode & 0o777).toBe(0o700);
      expect(statSync(strategy).mode & 0o777).toBe(0o600);
      const manifest = join(ctx.pacerHome, "install-manifest.json");
      writeFileSync(manifest, "old", { mode: 0o644 });
      chmodSync(manifest, 0o644);
      writeManifest(ctx, { version: 1, planners: {} });
      expect(statSync(manifest).mode & 0o777).toBe(0o600);
      const secrets = join(ctx.pacerHome, "secrets");
      mkdirSync(secrets, { mode: 0o700 });
      const sentinel = join(secrets, "sentinel.key");
      writeInstallFile(sentinel, "synthetic sentinel");
      expect(statSync(secrets).mode & 0o777).toBe(0o700);
      expect(statSync(sentinel).mode & 0o777).toBe(0o600);
      writeInstallFile(sentinel, "updated", 0o644);
      expect(statSync(sentinel).mode & 0o777).toBe(0o600);
      const onboarding = join(ctx.pacerHome, "onboarding");
      mkdirSync(onboarding, { mode: 0o755 });
      chmodSync(onboarding, 0o755);
      expect(onboardingSkip(ctx)).toEqual({ skipped: true });
      expect(statSync(onboarding).mode & 0o777).toBe(0o700);
      expect(statSync(join(onboarding, "skipped")).mode & 0o777).toBe(0o600);
      chmodSync(ctx.pacerHome, 0o755);
      chmodSync(strategy, 0o644);
      atomicStrategyWrite(strategy, readFileSync(strategy, "utf8"));
      expect(statSync(ctx.pacerHome).mode & 0o777).toBe(0o700);
      expect(statSync(strategy).mode & 0o777).toBe(0o600);
      chmodSync(ctx.pacerHome, 0o755);
      chmodSync(strategy, 0o644);
      expect((await initCmd(ctx, { force: true, planner: "codex" })).code).toBe(0);
      expect(statSync(ctx.pacerHome).mode & 0o777).toBe(0o700);
      expect(statSync(strategy).mode & 0o777).toBe(0o600);
      const backup = join(ctx.pacerHome, "strategy.yaml.pacer-bak-20261010-190000");
      expect(statSync(backup).mode & 0o777).toBe(0o600);
    }
  } finally { process.umask(originalUmask); }
});

test("agent detect, preview, consent, revision and disconnect stay isolated", async () => {
  const ctx = withVersionFixtures(fakeCtx({ which: bin => bin === "codex" ? process.execPath : null,
    run: async () => ({ code: 0, stdout: "codex 1.2.3\n", stderr: "" }), env: { PACER_BIN: "pacer" } }));
  const detected = await detectAgents(ctx);
  expect(detected.find(row => row.agent === "codex")).toMatchObject({ found: true, version: "1.2.3", path: ctx.which("codex") });
  const preview = await agentPreview(ctx, "codex");
  expect(preview.files.every(path => path.startsWith(ctx.home))).toBe(true);
  expect(preview.revision).toMatch(/^[a-f0-9]{64}$/);
  await expect(agentConnect(ctx, "codex")).rejects.toMatchObject({ code: "not_allowed" });
  await expect(agentConnect(ctx, "codex", { consent: true, preview_revision: "stale" })).rejects.toMatchObject({ code: "conflict" });
  const connected = await agentConnect(ctx, "codex", { consent: true, preview_revision: preview.revision });
  const manifestBytes = readFileSync(join(ctx.pacerHome, "install-manifest.json"), "utf8");
  const installedBytes = Object.fromEntries(connected.installed.map(path => [path.replaceAll(ctx.home, "$HOME"), readFileSync(path, "utf8")]));
  expect({ installed: connected.installed.map(path => path.replaceAll(ctx.home, "$HOME")), installedBytes,
    manifestBytes: manifestBytes.replaceAll(ctx.home, "$HOME") }).toMatchSnapshot();
  const disconnected = await agentDisconnect(ctx, "codex");
  expect({ removed: disconnected.removed.map(path => path.replaceAll(ctx.home, "$HOME")),
    manifestBytes: readFileSync(join(ctx.pacerHome, "install-manifest.json"), "utf8").replaceAll(ctx.home, "$HOME") }).toMatchSnapshot();
  expect(readManifest(ctx).planners.codex).toBeUndefined();
});

test("agent disconnect restores preexisting file bytes exactly", async () => {
  const ctx = withVersionFixtures(fakeCtx({ which: bin => bin === "codex" ? process.execPath : null,
    run: async () => ({ code: 0, stdout: "codex 1.2.3\n", stderr: "" }), env: { PACER_BIN: "pacer" } }));
  const dir = join(ctx.home, ".codex");
  mkdirSync(dir, { recursive: true });
  const agents = join(dir, "AGENTS.md"), hooks = join(dir, "hooks.json");
  const originalAgents = "# User note\r\nKeep this line.\r\n";
  const originalHooks = '{"hooks":{"SessionStart":[{"hooks":[{"command":"user start"}]}]},"other":true}\n';
  writeFileSync(agents, originalAgents);
  writeFileSync(hooks, originalHooks);
  const preview = await agentPreview(ctx, "codex");
  await agentConnect(ctx, "codex", { consent: true, preview_revision: preview.revision });
  expect({ agents: readFileSync(agents, "utf8"), hooks: readFileSync(hooks, "utf8"),
    manifest: readFileSync(join(ctx.pacerHome, "install-manifest.json"), "utf8").replaceAll(ctx.home, "$HOME") }).toMatchSnapshot();
  await agentDisconnect(ctx, "codex");
  expect(readFileSync(agents, "utf8")).toBe(originalAgents);
  expect(readFileSync(hooks, "utf8")).toBe(originalHooks);
});

test("doctor reads diagnostics without repairing and retired panel install refuses", async () => {
  const ctx = fakeCtx({ which: () => null, env: { PACER_BIN: "pacer" } });
  const result = await doctor(ctx);
  expect(result.checkedAt).toBe(ctx.now);
  expect(result.checks.find(check => check.name === "Strategy")?.level).toBe("fail");
  expect(existsSync(join(ctx.pacerHome, "install-manifest.json"))).toBe(false);
  expect(() => pluginInstall()).toThrow("pacer no longer ships an Orca plugin");
  expect((await pluginCli(["install"], ctx)).code).toBe(2);
  expect((await pluginCli(["uninstall"], ctx)).code).toBe(1);
});

test("legacy panel cleanup removes owned bytes and refuses a forged record", async () => {
  const ctx = fakeCtx({ which: () => null, env: { PACER_BIN: "pacer" } });
  const root = await installLegacyPlugin(ctx);
  expect(existsSync(join(root, "panel/live.html"))).toBe(true);
  const report = await uninstallPlugin(ctx, "linux");
  expect(report?.removed).toContain(join(root, "panel/live.html"));
  expect(readManifest(ctx).planners["orca-plugin"]).toBeUndefined();
  await installLegacyPlugin(ctx);
  const manifest = readManifest(ctx);
  const privatePath = join(ctx.pacerHome, "secrets", "sentinel.key");
  const secrets = join(ctx.pacerHome, "secrets");
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  writeInstallFile(privatePath, "synthetic sentinel");
  expect(statSync(secrets).mode & 0o777).toBe(0o700);
  expect(statSync(privatePath).mode & 0o777).toBe(0o600);
  manifest.planners["orca-plugin"].files[0].path = privatePath;
  writeManifest(ctx, manifest);
  await expect(uninstallPlugin(ctx, "linux")).rejects.toMatchObject({ code: "capability_denied" });
  expect(readFileSync(privatePath, "utf8")).toBe("synthetic sentinel");
});
