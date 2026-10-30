import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./install-plugin-fixtures";
import { PACER } from "./install-helpers";
import { installPlanner } from "../src/install";
import { readManifest, writeManifest } from "../src/install/manifest";
import { sha256 } from "../src/install/fsx";
import { reconcileIntegrations, integrationFreshness } from "../src/install/reconcile";

async function connected(agent: "codex" | "claude-code" = "codex") {
  const ctx = fakeCtx({ env: { PACER_BIN: PACER[0] }, run: async () => { throw Error("automatic refresh executed a CLI"); } });
  await installPlanner({ ctx, pacerArgv: PACER }, agent);
  const root = join(ctx.home, agent === "codex" ? ".codex" : ".claude");
  return { ctx, root, skill: join(root, "skills/pacer/SKILL.md") };
}

test("old intact assets migrate, subsequent refresh is a no-op and doctor assessment is read-only", async () => {
  const { ctx, skill } = await connected();
  const current = readFileSync(skill, "utf8"), manifest = readManifest(ctx);
  writeFileSync(skill, "old release skill");
  const file = manifest.planners.codex.files.find(f => f.path === skill)!;
  file.afterHash = sha256("old release skill"); delete file.managed;
  writeManifest(ctx, manifest);
  const before = readFileSync(join(ctx.pacerHome, "install-manifest.json"), "utf8");
  expect((await integrationFreshness(ctx, "codex")).state).toBe("refreshed");
  expect(readFileSync(skill, "utf8")).toBe("old release skill");
  expect(readFileSync(join(ctx.pacerHome, "install-manifest.json"), "utf8")).toBe(before);
  expect((await reconcileIntegrations(ctx))[0].state).toBe("refreshed");
  expect(readFileSync(skill, "utf8")).toBe(current);
  const saved = readFileSync(join(ctx.pacerHome, "install-manifest.json"), "utf8");
  expect((await reconcileIntegrations(ctx))[0].state).toBe("current");
  expect(readFileSync(join(ctx.pacerHome, "install-manifest.json"), "utf8")).toBe(saved);
});

test("customized managed content conflicts without overwriting any planned assets", async () => {
  const { ctx, root, skill } = await connected();
  writeFileSync(skill, "user customized instructions");
  const hooks = join(root, "hooks.json"), before = readFileSync(hooks, "utf8");
  ctx.env.PACER_BIN = "/opt/new/pacer";
  expect((await reconcileIntegrations(ctx))[0].state).toBe("conflict");
  expect(readFileSync(skill, "utf8")).toBe("user customized instructions");
  expect(readFileSync(hooks, "utf8")).toBe(before);
});

test("unrelated shared settings survive refresh and changed owned hooks conflict", async () => {
  const { ctx, root } = await connected();
  const hooks = join(root, "hooks.json"), doc = JSON.parse(readFileSync(hooks, "utf8"));
  doc.theme = "dark"; writeFileSync(hooks, JSON.stringify(doc));
  ctx.env.PACER_BIN = "/opt/new/pacer";
  expect((await reconcileIntegrations(ctx))[0].state).toBe("refreshed");
  expect(JSON.parse(readFileSync(hooks, "utf8")).theme).toBe("dark");
  const changed = JSON.parse(readFileSync(hooks, "utf8"));
  changed.hooks.SessionStart[0].hooks[0].timeout = 99;
  writeFileSync(hooks, JSON.stringify(changed));
  expect((await reconcileIntegrations(ctx))[0].state).toBe("conflict");
  expect(JSON.parse(readFileSync(hooks, "utf8")).hooks.SessionStart[0].hooks[0].timeout).toBe(99);
});

test("legacy Claude install accepts unrelated settings edits when owned hooks are intact", async () => {
  const { ctx, root } = await connected("claude-code");
  const path = join(root, "settings.json");
  const manifest = readManifest(ctx);
  const file = manifest.planners["claude-code"].files.find(item => item.path === path)!;
  delete file.managed;
  writeManifest(ctx, manifest);
  const settings = JSON.parse(readFileSync(path, "utf8"));
  settings.theme = "dark";
  writeFileSync(path, JSON.stringify(settings));

  const unchangedImage = readFileSync(path, "utf8"), unchangedInode = statSync(path).ino;
  expect((await reconcileIntegrations(ctx, { target: "claude-code" }))[0].state).toBe("refreshed");
  expect(readFileSync(path, "utf8")).toBe(unchangedImage);
  expect(statSync(path).ino).toBe(unchangedInode);
  expect(JSON.parse(readFileSync(path, "utf8")).theme).toBe("dark");
  expect(readManifest(ctx).planners["claude-code"].files.find(item => item.path === path)?.managed).toBeDefined();
});

test("legacy Claude install still rejects edits to a pacer-owned hook", async () => {
  const { ctx, root } = await connected("claude-code");
  const path = join(root, "settings.json");
  const manifest = readManifest(ctx);
  delete manifest.planners["claude-code"].files.find(item => item.path === path)!.managed;
  writeManifest(ctx, manifest);
  const settings = JSON.parse(readFileSync(path, "utf8"));
  settings.hooks.SessionStart[0].hooks[0].timeout = 99;
  writeFileSync(path, JSON.stringify(settings));

  expect((await reconcileIntegrations(ctx, { target: "claude-code" }))[0].state).toBe("conflict");
  expect(JSON.parse(readFileSync(path, "utf8")).hooks.SessionStart[0].hooks[0].timeout).toBe(99);
});

test("legacy Claude install rejects a changed pacer-owned status line", async () => {
  const { ctx, root } = await connected("claude-code");
  const path = join(root, "settings.json");
  const manifest = readManifest(ctx);
  delete manifest.planners["claude-code"].files.find(item => item.path === path)!.managed;
  writeManifest(ctx, manifest);
  const settings = JSON.parse(readFileSync(path, "utf8"));
  settings.statusLine.command = "my-custom-status";
  writeFileSync(path, JSON.stringify(settings));

  expect((await reconcileIntegrations(ctx, { target: "claude-code" }))[0].state).toBe("conflict");
  expect(JSON.parse(readFileSync(path, "utf8")).statusLine.command).toBe("my-custom-status");
});

test("missing owned files are recreated and malformed configuration is preserved", async () => {
  const { ctx, root, skill } = await connected();
  rmSync(skill);
  expect((await reconcileIntegrations(ctx))[0].state).toBe("refreshed");
  expect(existsSync(skill)).toBe(true);
  const hooks = join(root, "hooks.json"); writeFileSync(hooks, "bad json");
  expect((await reconcileIntegrations(ctx))[0].state).toBe("conflict");
  expect(readFileSync(hooks, "utf8")).toBe("bad json");
});

test("automatic Claude refresh preserves MCP and never invokes agent commands", async () => {
  const { ctx, skill } = await connected("claude-code");
  ctx.which = () => "claude";
  const manifest = readManifest(ctx), file = manifest.planners["claude-code"].files.find(f => f.path === skill)!;
  writeFileSync(skill, "old"); file.afterHash = sha256("old"); delete file.managed; writeManifest(ctx, manifest);
  expect((await reconcileIntegrations(ctx))[0].state).toBe("refreshed");
});

test("no integrations means no writes and unrelated install records are ignored", async () => {
  const ctx = fakeCtx();
  expect(await reconcileIntegrations(ctx)).toEqual([]);
  expect(existsSync(join(ctx.pacerHome, "install-manifest.json"))).toBe(false);
});

test("named account refresh stays in its recorded folder and rejects changed account identity", async () => {
  const ctx = fakeCtx({ env: { PACER_BIN: PACER[0] } });
  const folder = join(ctx.home, "accounts/work");
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({ planner: "codex#work", accounts: { work: { kind: "codex", home: folder, usage: "quota" } }, runners: { "codex#work": {} }, routing: [{ default: ["codex#work"] }] }));
  await installPlanner({ ctx, pacerArgv: PACER }, { agent: "codex", account: "work" });
  const skill = join(folder, "skills/pacer/SKILL.md"); rmSync(skill);
  expect((await reconcileIntegrations(ctx))[0]).toEqual({ target: "codex#work", state: "refreshed" });
  expect(existsSync(skill)).toBe(true);
  expect(existsSync(join(ctx.home, ".codex"))).toBe(false);
  const strategy = JSON.parse(readFileSync(join(ctx.pacerHome, "strategy.yaml"), "utf8"));
  strategy.accounts.work.home = join(ctx.home, "accounts/other");
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify(strategy));
  expect((await reconcileIntegrations(ctx))[0].state).toBe("conflict");
  expect(existsSync(join(ctx.home, "accounts/other"))).toBe(false);
});

test("concurrent refreshes converge once and preserve uninstall ownership", async () => {
  const { ctx, skill } = await connected(); rmSync(skill);
  const results = await Promise.all([reconcileIntegrations(ctx), reconcileIntegrations(ctx), reconcileIntegrations(ctx)]);
  expect(results.flat().filter(result => result.state === "refreshed")).toHaveLength(1);
  expect(results.flat().filter(result => result.state === "current")).toHaveLength(2);
  const { uninstallPlanner } = await import("../src/install/uninstall");
  await uninstallPlanner(ctx, "codex");
  expect(existsSync(skill)).toBe(false);
});

test("customized owned status line is preserved as a conflict even when the adapter leaves it alone", async () => {
  const { ctx, root } = await connected("claude-code");
  const path = join(root, "settings.json"), doc = JSON.parse(readFileSync(path, "utf8"));
  doc.statusLine.command = "my-custom-status";
  writeFileSync(path, JSON.stringify(doc));
  expect((await reconcileIntegrations(ctx))[0].state).toBe("conflict");
  expect(JSON.parse(readFileSync(path, "utf8")).statusLine.command).toBe("my-custom-status");
});

test("enabled file-managed MCP follows the current command while disabled MCP stays disabled", async () => {
  for (const agent of ["codex", "cursor", "opencode"] as const) {
    for (const enabled of [true, false]) {
      const ctx = fakeCtx({ env: { PACER_BIN: "/opt/old/pacer" } });
      await installPlanner({ ctx, pacerArgv: ["/opt/old/pacer"], mcp: enabled }, agent);
      ctx.env.PACER_BIN = "/opt/new/pacer";
      expect((await reconcileIntegrations(ctx))[0].state).toBe("refreshed");
      const path = agent === "codex" ? join(ctx.home, ".codex/config.toml") : agent === "cursor" ? join(ctx.home, ".cursor/mcp.json") : join(ctx.home, ".config/opencode/opencode.json");
      if (enabled) {
        expect(readFileSync(path, "utf8")).toContain("/opt/new/pacer");
        expect(readFileSync(path, "utf8")).not.toContain("/opt/old/pacer");
      } else expect(existsSync(path)).toBe(false);
      expect((await reconcileIntegrations(ctx))[0].state).toBe("current");
    }
  }
});

test("legacy Codex split skill root is refreshed in place without creating another skill", async () => {
  const ctx = fakeCtx({ env: { PACER_BIN: PACER[0] } }), skillRoot = join(ctx.home, "custom-codex");
  ctx.env.CODEX_HOME = skillRoot;
  await installPlanner({ ctx, pacerArgv: PACER }, "codex");
  const path = join(skillRoot, "skills/pacer/SKILL.md"), desired = readFileSync(path, "utf8");
  const manifest = readManifest(ctx), file = manifest.planners.codex.files.find(item => item.path === path)!;
  writeFileSync(path, "legacy"); file.afterHash = sha256("legacy"); delete file.managed; writeManifest(ctx, manifest);
  expect((await reconcileIntegrations(ctx))[0].state).toBe("refreshed");
  expect(readFileSync(path, "utf8")).toBe(desired);
  expect(existsSync(join(ctx.home, ".codex/skills/pacer/SKILL.md"))).toBe(false);
});

test("repeated missing-file repair writes even when manifest metadata already matches", async () => {
  const { ctx, skill } = await connected();
  await reconcileIntegrations(ctx);
  for (let i = 0; i < 2; i++) {
    rmSync(skill);
    expect((await reconcileIntegrations(ctx))[0].state).toBe("refreshed");
    expect(existsSync(skill)).toBe(true);
  }
});

test("malformed config diagnostics do not disclose configuration contents", async () => {
  const { ctx, root } = await connected();
  writeFileSync(join(root, "hooks.json"), "secret-value-that-must-not-be-logged");
  const result = await reconcileIntegrations(ctx);
  expect(JSON.stringify(result)).not.toContain("secret-value-that-must-not-be-logged");
  expect(result[0].state).toBe("conflict");
});


test("no-op reconcile ownership images stay bound through final manifest settlement", async () => {
  const { writeNative } = await import("../src/plugins/write-native");
  const { ctx, root, skill } = await connected("claude-code");
  const settingsPath = join(root, "settings.json");
  const manifest = readManifest(ctx);
  delete manifest.planners["claude-code"].files.find(file => file.path === settingsPath)!.managed;
  writeFileSync(skill, "old release skill");
  const skillRecord = manifest.planners["claude-code"].files.find(file => file.path === skill)!;
  skillRecord.afterHash = sha256("old release skill"); delete skillRecord.managed;
  writeManifest(ctx, manifest);
  const beforeManifest = readFileSync(join(ctx.pacerHome, "install-manifest.json"), "utf8");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")); settings.theme = "dark";
  writeFileSync(settingsPath, JSON.stringify(settings));
  const native = writeNative(), rename = native.renameAt;
  let changed = false;
  native.renameAt = (from, old, to, name) => {
    rename(from, old, to, name);
    if (!changed && name === "SKILL.md") {
      changed = true; settings.theme = "concurrent";
      writeFileSync(settingsPath, JSON.stringify(settings));
    }
  };
  try {
    expect((await reconcileIntegrations(ctx, { target: "claude-code" }))[0].state).toBe("conflict");
    expect(changed).toBe(true);
    expect(readFileSync(skill, "utf8")).toBe("old release skill");
    expect(JSON.parse(readFileSync(settingsPath, "utf8")).theme).toBe("concurrent");
    expect(readFileSync(join(ctx.pacerHome, "install-manifest.json"), "utf8")).toBe(beforeManifest);
  } finally { native.renameAt = rename; }
});
