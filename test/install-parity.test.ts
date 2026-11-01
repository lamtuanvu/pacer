import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./install-plugin-fixtures";
import { installLegacyPlugin } from "./helpers";
import { parseJsonc, setMember, removeMember } from "../src/install/jsonc";
import { applyUndo } from "../src/install/manifest";
import { init, agentPreview, agentConnect, agentDisconnect, doctor, pluginInstall } from "../src/core/setup";
import { checkSetup } from "../src/setup/check";
import { detectAgents } from "../src/install/detection";
import { uninstallPlugin } from "../src/plugin/install";
import { pluginCli } from "../src/plugin/cli";
import { readManifest, writeManifest } from "../src/install/manifest";
import { withVersionFixtures } from "./planner-detect-fixtures";

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
  expect(readFileSync(result.strategy, "utf8")).toContain("codex");
  const checked = await checkSetup(ctx, { snapshotProbe: false, deferStatus: true });
  expect(checked.items.find(item => item.id === "planner")?.detail).toContain("codex");
  expect(checked.integration).toEqual({ configuration: "unverified", invocation: "unverified" });
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
  expect((await agentConnect(ctx, "codex", { consent: true, preview_revision: preview.revision })).installed.length).toBeGreaterThan(0);
  expect(readManifest(ctx).planners.codex?.files.length).toBeGreaterThan(0);
  expect((await agentDisconnect(ctx, "codex")).removed.length).toBeGreaterThan(0);
  expect(readManifest(ctx).planners.codex).toBeUndefined();
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
  mkdirSync(join(ctx.pacerHome, "secrets"), { recursive: true });
  writeFileSync(privatePath, "synthetic sentinel");
  manifest.planners["orca-plugin"].files[0].path = privatePath;
  writeManifest(ctx, manifest);
  await expect(uninstallPlugin(ctx, "linux")).rejects.toMatchObject({ code: "capability_denied" });
  expect(readFileSync(privatePath, "utf8")).toBe("synthetic sentinel");
});
