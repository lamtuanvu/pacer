import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { callOp } from "../src/api/ops";
import { toApiError } from "../src/api/protocol";
import { pluginRegistry, shutdownPlugins } from "../src/plugins";
import { setPluginDisabled, setPluginGrant } from "../src/plugins/config";
import { pluginLogPath } from "../src/plugins/host";
import { workflowDefinitionsReplyBytes, workflowDefinitionsReplyFits } from "../src/plugins/workflow-protocol";
import { pluginNativeRequest } from "../src/serve/plugin-native";
import {
  addDefinition, getDefinition, getDefinitionPrompt, isDefinitionDisabled, listDefinitionPrompts, listDefinitions,
  setPluginDefinitionsDisabled, workflowDatabase,
} from "../src/workflow/store";
import {
  reconcilePluginWorkflowFlags, syncAllPluginWorkflows, syncPluginWorkflows,
} from "../src/workflow/plugin-sync";
import { chooseWorkflow, defaultEngineDeps, onTaskSettled, recordStepResult, startRun } from "../src/workflow/engine";
import { getRun, stepsOfRun } from "../src/workflow/store";
import { parseWorkflow } from "../src/workflow/parse";
import { updateTask } from "../src/tasks/store";
import type { SpawnRunner } from "../src/tasks/api";
import { fakeCtx, gitRepo, tmpDir } from "./helpers";

const contexts: ReturnType<typeof fakeCtx>[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => shutdownPlugins(ctx)));
});

function home() {
  const dir = tmpDir();
  const ctx = fakeCtx({
    home: dir, pacerHome: join(dir, ".pacer"),
    env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
    now: Date.now() / 1000,
  });
  contexts.push(ctx);
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(dir, "node_modules"), "dir");
  mkdirSync(join(ctx.pacerHome, "plugins"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
  return ctx;
}

const codeOf = async (p: Promise<unknown>) => {
  try { await p; return "no error"; }
  catch (e) { return toApiError(e).code; }
};

const MINIMAL = (id: string, version = 1, prompt = "inline") => `
id: ${id}
version: ${version}
steps:
  go:
    type: agent
    kind: research
    prompt: ${prompt}
  done: { type: end }
edges: [[go, done]]
`;

type Page = {
  name: string; version: number; source: string; prompts: Record<string, string>; next?: string;
};

/** Install a tiny workflow plugin whose `workflow.definitions` serves the given pages. */
function installWorkflowPlugin(
  ctx: ReturnType<typeof fakeCtx>,
  id: string,
  pages: Page[],
  opts: { names?: string[]; version?: string } = {},
): string {
  const dir = join(ctx.pacerHome, "plugins", id);
  mkdirSync(dir, { recursive: true });
  const names = opts.names ?? [...new Set(pages.map(p => p.name))];
  const contributes: Record<string, { title?: string }> = {};
  for (const name of names) contributes[name] = { title: name };
  writeFileSync(join(dir, "pacer-plugin.json"), JSON.stringify({
    id, version: opts.version ?? "1.0.0", publisher: "test", host: ">=1.12.0",
    entry: "main.ts", contributes: { workflow: contributes }, capabilities: [],
  }));
  writeFileSync(join(dir, "pages.json"), JSON.stringify(pages));
  writeFileSync(join(dir, "main.ts"), `#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { serve, stdinLines } from "@pacer/plugin";
const manifest = JSON.parse(readFileSync("pacer-plugin.json", "utf8"));
const pages = JSON.parse(readFileSync("pages.json", "utf8"));
await serve({
  manifest, input: stdinLines(),
  handlers: {
    "diagnostic.ping": async () => ({ ok: true, uptimeS: 0 }),
    "workflow.definitions": async (params) => {
      const after = params && typeof params === "object" && "after" in params ? String((params as { after?: string }).after ?? "") : "";
      const idx = after ? pages.findIndex((p) => \`\${p.name}@\${p.version}\` === after) : 0;
      if (idx < 0) return { workflows: [] };
      const page = pages[idx];
      if (!page) return { workflows: [] };
      const { next: _n, ...entry } = page;
      const next = page.next ?? (pages[idx + 1] ? \`\${pages[idx + 1].name}@\${pages[idx + 1].version}\` : undefined);
      return { workflows: [entry], ...(next ? { next } : {}) };
    },
  },
});
`);
  chmodSync(join(dir, "main.ts"), 0o755);
  return dir;
}

async function enable(ctx: ReturnType<typeof fakeCtx>, id: string) {
  const first = await callOp(ctx, "plugin.enable", { id }) as { state: string };
  if (first.state === "needs_grant") await callOp(ctx, "plugin.enable", { id, grant: true });
  await syncPluginWorkflows(ctx, id);
}

test("happy sync stores plugin origin, prompts, and list metadata", async () => {
  const ctx = home();
  const source = MINIMAL("fx-wf/feature", 1, "prompts/start.md");
  installWorkflowPlugin(ctx, "fx-wf", [{
    name: "feature", version: 1, source, prompts: { "prompts/start.md": "Do the feature." },
  }]);
  await enable(ctx, "fx-wf");
  expect(getDefinition(ctx, "fx-wf/feature@1")).toMatchObject({ id: "fx-wf/feature", version: 1 });
  expect(getDefinitionPrompt(ctx, "fx-wf/feature", 1, "prompts/start.md")).toBe("Do the feature.");
  expect(listDefinitions(ctx)).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "fx-wf/feature", version: 1, origin: "plugin:fx-wf@1.0.0", disabled: false }),
  ]));
  // Re-sync is a no-op for the same source.
  await syncPluginWorkflows(ctx, "fx-wf");
  expect(listDefinitions(ctx).filter(d => d.id === "fx-wf/feature")).toHaveLength(1);
}, 30000);

test("namespace violation, undeclared name, missing prompt, and oversized page are diagnostics", async () => {
  const ctx = home();
  installWorkflowPlugin(ctx, "fx-ns", [{
    name: "feature", version: 1, source: MINIMAL("other/feature"), prompts: {},
  }], { names: ["feature"] });
  await enable(ctx, "fx-ns");
  expect(getDefinition(ctx, "fx-ns/feature")).toBeNull();
  expect(readFileSync(pluginLogPath(ctx, "fx-ns"), "utf8")).toMatch(/outside plugin namespace|does not match/);

  const ctx2 = home();
  installWorkflowPlugin(ctx2, "fx-undecl", [{
    name: "secret", version: 1, source: MINIMAL("fx-undecl/secret"), prompts: {},
  }], { names: ["feature"] });
  await enable(ctx2, "fx-undecl");
  expect(getDefinition(ctx2, "fx-undecl/secret")).toBeNull();
  expect(readFileSync(pluginLogPath(ctx2, "fx-undecl"), "utf8")).toMatch(/not declared/);

  const ctx3 = home();
  installWorkflowPlugin(ctx3, "fx-miss", [{
    name: "feature", version: 1, source: MINIMAL("fx-miss/feature", 1, "prompts/missing.md"), prompts: {},
  }]);
  await enable(ctx3, "fx-miss");
  expect(getDefinition(ctx3, "fx-miss/feature")).toBeNull();
  expect(readFileSync(pluginLogPath(ctx3, "fx-miss"), "utf8")).toMatch(/missing prompt/);

  const ctx4 = home();
  const huge = "x".repeat(60_000);
  const prompts: Record<string, string> = {};
  for (let i = 0; i < 20; i++) prompts[`p${i}.md`] = huge;
  installWorkflowPlugin(ctx4, "fx-big", [{
    name: "feature", version: 1, source: MINIMAL("fx-big/feature"), prompts,
  }]);
  await enable(ctx4, "fx-big");
  expect(getDefinition(ctx4, "fx-big/feature")).toBeNull();
  // Transport (1 MiB) or the host's 960 KiB gate refuses before anything is stored.
  expect(readFileSync(pluginLogPath(ctx4, "fx-big"), "utf8")).toMatch(/960 KiB|invalid|exceeds|too_large|frame/);
}, 60000);

test("two pages sync; disable blocks new starts but running runs finish", async () => {
  const ctx = home();
  const a = MINIMAL("fx-page/one", 1);
  const b = MINIMAL("fx-page/two", 1);
  installWorkflowPlugin(ctx, "fx-page", [
    { name: "one", version: 1, source: a, prompts: {}, next: "two@1" },
    { name: "two", version: 1, source: b, prompts: {} },
  ]);
  await enable(ctx, "fx-page");
  expect(getDefinition(ctx, "fx-page/one@1")).not.toBeNull();
  expect(getDefinition(ctx, "fx-page/two@1")).not.toBeNull();

  const repo = gitRepo();
  // Start a run before disable so it can finish on the pinned version.
  const run = await startRun(ctx, { workflow: "fx-page/one@1", repo, brief: "go" }, undefined, {
    ...defaultEngineDeps,
    delegate: async (c, input) => {
      const { createTask } = await import("../src/tasks/store");
      return createTask(c, {
        brief: input.brief, kind: input.kind ?? null, requestedExecutor: null, timeoutS: 60,
        title: input.title, requestId: input.requestId,
      });
    },
  });
  expect(run.status).toBe("running");

  await callOp(ctx, "plugin.disable", { id: "fx-page" });
  expect(isDefinitionDisabled(ctx, "fx-page/one@1")).toBe(true);
  expect(await codeOf(callOp(ctx, "run.start", {
    workflow: "fx-page/one@1", repo, brief: "nope",
  }))).toBe("not_allowed");

  // Pinned definition still resolves for the live run.
  expect(getDefinition(ctx, "fx-page/one@1")).not.toBeNull();
  expect(workflowDatabase(ctx).query("SELECT status FROM workflow_runs WHERE id = ?").get(run.id)).toMatchObject({ status: "running" });
}, 60000);

test("hand-added workflow.add records origin manual", async () => {
  const ctx = home();
  const result = await callOp(ctx, "workflow.add", { source: MINIMAL("hand/one") }) as { id: string; created: boolean };
  expect(result).toMatchObject({ id: "hand/one", created: true });
  expect(listDefinitions(ctx).find(d => d.id === "hand/one")).toMatchObject({ origin: "manual", disabled: false });
});

function installMainTsPlugin(
  ctx: ReturnType<typeof fakeCtx>,
  id: string,
  body: string,
  opts: { names?: string[]; version?: string } = {},
): string {
  const dir = join(ctx.pacerHome, "plugins", id);
  mkdirSync(dir, { recursive: true });
  const names = opts.names ?? ["feature"];
  const contributes: Record<string, { title?: string }> = {};
  for (const name of names) contributes[name] = { title: name };
  writeFileSync(join(dir, "pacer-plugin.json"), JSON.stringify({
    id, version: opts.version ?? "1.0.0", publisher: "test", host: ">=1.12.0",
    entry: "main.ts", contributes: { workflow: contributes }, capabilities: [],
  }));
  writeFileSync(join(dir, "main.ts"), `#!/usr/bin/env bun
${body}
`);
  chmodSync(join(dir, "main.ts"), 0o755);
  return dir;
}

test("endless next cursor hits 256-page cap (diagnostic)", async () => {
  const ctx = home();
  installMainTsPlugin(ctx, "fx-loop", `
import { readFileSync } from "node:fs";
import { serve, stdinLines } from "@pacer/plugin";
const manifest = JSON.parse(readFileSync("pacer-plugin.json", "utf8"));
await serve({
  manifest, input: stdinLines(),
  handlers: {
    "diagnostic.ping": async () => ({ ok: true, uptimeS: 0 }),
    "workflow.definitions": async (params) => {
      const after = params && typeof params === "object" && "after" in params ? String((params as { after?: string }).after ?? "") : "";
      const version = after ? Number(after.split("@")[1] ?? 0) + 1 : 1;
      const source = \`id: fx-loop/feature\\nversion: \${version}\\nsteps:\\n  go: { type: agent, kind: research, prompt: inline }\\n  done: { type: end }\\nedges: [[go, done]]\\n\`;
      return { workflows: [{ name: "feature", version, source, prompts: {} }], next: \`feature@\${version}\` };
    },
  },
});
`, { names: ["feature"] });
  await enable(ctx, "fx-loop");
  expect(readFileSync(pluginLogPath(ctx, "fx-loop"), "utf8")).toMatch(/exceeded 256 pages/);
}, 120000);

test("duplicate names across pages are a diagnostic", async () => {
  const ctx = home();
  const source = MINIMAL("fx-dup/feature", 1);
  const dir = installMainTsPlugin(ctx, "fx-dup", `
import { readFileSync } from "node:fs";
import { serve, stdinLines } from "@pacer/plugin";
const manifest = JSON.parse(readFileSync("pacer-plugin.json", "utf8"));
const source = readFileSync("source.txt", "utf8");
let n = 0;
await serve({
  manifest, input: stdinLines(),
  handlers: {
    "diagnostic.ping": async () => ({ ok: true, uptimeS: 0 }),
    "workflow.definitions": async () => {
      n++;
      const entry = { name: "feature", version: 1, source, prompts: {} };
      return { workflows: [entry], ...(n < 2 ? { next: "page-2" } : {}) };
    },
  },
});
`);
  writeFileSync(join(dir, "source.txt"), source);
  await enable(ctx, "fx-dup");
  await syncPluginWorkflows(ctx, "fx-dup");
  const deadline = Date.now() + 8000;
  let log = "";
  while (Date.now() < deadline) {
    try {
      log = readFileSync(pluginLogPath(ctx, "fx-dup"), "utf8");
      if (/duplicate workflow 'feature@1' across pages/.test(log)) break;
    } catch { /* log not created yet */ }
    await Bun.sleep(25);
  }
  expect(log).toMatch(/duplicate workflow 'feature@1' across pages/);
}, 30000);

test("per-page timeout is enforced via injectable deadlineMs", async () => {
  const ctx = home();
  installMainTsPlugin(ctx, "fx-hang", `
import { readFileSync } from "node:fs";
import { serve, stdinLines } from "@pacer/plugin";
const manifest = JSON.parse(readFileSync("pacer-plugin.json", "utf8"));
await serve({
  manifest, input: stdinLines(),
  handlers: {
    "diagnostic.ping": async () => ({ ok: true, uptimeS: 0 }),
    "workflow.definitions": async () => new Promise(() => {}),
  },
});
`);
  await callOp(ctx, "plugin.enable", { id: "fx-hang", grant: true });
  await syncPluginWorkflows(ctx, "fx-hang", { deadlineMs: 80 });
  expect(readFileSync(pluginLogPath(ctx, "fx-hang"), "utf8")).toMatch(/workflow\.definitions failed|timeout|deadline/i);
}, 30000);

test("same id@version with different source logs source_mismatch; new source not stored", async () => {
  const ctx = home();
  const v1 = MINIMAL("fx-mis/feature", 1, "v1");
  installWorkflowPlugin(ctx, "fx-mis", [{ name: "feature", version: 1, source: v1, prompts: {} }]);
  await enable(ctx, "fx-mis");
  expect(workflowDatabase(ctx).query("SELECT source FROM workflow_defs WHERE id = ? AND version = ?")
    .get("fx-mis/feature", 1)).toMatchObject({ source: v1 });

  const v2 = MINIMAL("fx-mis/feature", 1, "v2");
  writeFileSync(join(ctx.pacerHome, "plugins", "fx-mis", "pages.json"), JSON.stringify([
    { name: "feature", version: 1, source: v2, prompts: {} },
  ]));
  await callOp(ctx, "plugin.disable", { id: "fx-mis" });
  await callOp(ctx, "plugin.enable", { id: "fx-mis", grant: true });
  await syncPluginWorkflows(ctx, "fx-mis");
  expect(readFileSync(pluginLogPath(ctx, "fx-mis"), "utf8")).toMatch(/already exists with a different source/);
  expect(workflowDatabase(ctx).query("SELECT source FROM workflow_defs WHERE id = ? AND version = ?")
    .get("fx-mis/feature", 1)).toMatchObject({ source: v1 });
}, 30000);

test("same id@version with different prompts is a diagnostic; stored prompts unchanged", async () => {
  const ctx = home();
  const source = MINIMAL("fx-pr/feature", 1, "prompts/a.md");
  installWorkflowPlugin(ctx, "fx-pr", [{
    name: "feature", version: 1, source, prompts: { "prompts/a.md": "first" },
  }]);
  await enable(ctx, "fx-pr");
  expect(getDefinitionPrompt(ctx, "fx-pr/feature", 1, "prompts/a.md")).toBe("first");

  writeFileSync(join(ctx.pacerHome, "plugins", "fx-pr", "pages.json"), JSON.stringify([
    { name: "feature", version: 1, source, prompts: { "prompts/a.md": "second" } },
  ]));
  await callOp(ctx, "plugin.disable", { id: "fx-pr" });
  await callOp(ctx, "plugin.enable", { id: "fx-pr", grant: true });
  await syncPluginWorkflows(ctx, "fx-pr");
  expect(readFileSync(pluginLogPath(ctx, "fx-pr"), "utf8")).toMatch(/already exists with a different source/);
  expect(getDefinitionPrompt(ctx, "fx-pr/feature", 1, "prompts/a.md")).toBe("first");
  expect(listDefinitionPrompts(ctx, "fx-pr/feature", 1)).toEqual({ "prompts/a.md": "first" });
}, 30000);

test("re-enable clears workflow_defs.disabled for that plugin", async () => {
  const ctx = home();
  installWorkflowPlugin(ctx, "fx-ren", [{
    name: "feature", version: 1, source: MINIMAL("fx-ren/feature"), prompts: {},
  }]);
  await enable(ctx, "fx-ren");
  expect(isDefinitionDisabled(ctx, "fx-ren/feature@1")).toBe(false);
  await callOp(ctx, "plugin.disable", { id: "fx-ren" });
  expect(isDefinitionDisabled(ctx, "fx-ren/feature@1")).toBe(true);
  await callOp(ctx, "plugin.enable", { id: "fx-ren", grant: true });
  await syncPluginWorkflows(ctx, "fx-ren");
  expect(isDefinitionDisabled(ctx, "fx-ren/feature@1")).toBe(false);
}, 30000);

test("native changed(reset) syncs workflows like TypeScript enable", async () => {
  const ctx = home();
  installWorkflowPlugin(ctx, "fx-nat", [{
    name: "feature", version: 1, source: MINIMAL("fx-nat/feature"), prompts: {},
  }]);
  // Simulate Rust plugin.enable: write grant/disabled, then notify Core via changed(reset).
  await setPluginGrant(ctx, "fx-nat", { version: "1.0.0", capabilities: [], workflows: ["feature"] });
  await setPluginDisabled(ctx, "fx-nat", false);
  expect(getDefinition(ctx, "fx-nat/feature@1")).toBeNull();
  const out = await pluginNativeRequest(ctx, { kind: "changed", id: "fx-nat", reset: true, invalidate: false });
  expect(out.error).toBeUndefined();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (getDefinition(ctx, "fx-nat/feature@1")) break;
    await Bun.sleep(50);
  }
  expect(getDefinition(ctx, "fx-nat/feature@1")).toMatchObject({ id: "fx-nat/feature", version: 1 });
  expect(listDefinitions(ctx)).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "fx-nat/feature", origin: "plugin:fx-nat@1.0.0", disabled: false }),
  ]));
}, 30000);

test("native changed without reset disables workflows when the plugin is not live", async () => {
  const ctx = home();
  installWorkflowPlugin(ctx, "fx-ndis", [{
    name: "feature", version: 1, source: MINIMAL("fx-ndis/feature"), prompts: {},
  }]);
  await enable(ctx, "fx-ndis");
  expect(isDefinitionDisabled(ctx, "fx-ndis/feature@1")).toBe(false);
  await setPluginDisabled(ctx, "fx-ndis", true);
  const out = await pluginNativeRequest(ctx, { kind: "changed", id: "fx-ndis", reset: false, invalidate: false });
  expect(out.error).toBeUndefined();
  expect(isDefinitionDisabled(ctx, "fx-ndis/feature@1")).toBe(true);
}, 30000);

test("uninstall leaves definitions disabled; new runs are refused", async () => {
  const ctx = home();
  const repo = gitRepo();
  installWorkflowPlugin(ctx, "fx-rm", [{
    name: "feature", version: 1, source: MINIMAL("fx-rm/feature"), prompts: {},
  }]);
  await enable(ctx, "fx-rm");
  await callOp(ctx, "plugin.remove", { id: "fx-rm" });
  expect(isDefinitionDisabled(ctx, "fx-rm/feature@1")).toBe(true);
  expect(await codeOf(callOp(ctx, "run.start", { workflow: "fx-rm/feature@1", repo, brief: "nope" }))).toBe("not_allowed");
}, 30000);

test("strategy.yaml plugins.disabled blocks starts without plugin.disable", async () => {
  const ctx = home();
  const repo = gitRepo();
  installWorkflowPlugin(ctx, "fx-str", [{
    name: "feature", version: 1, source: MINIMAL("fx-str/feature"), prompts: {},
  }]);
  await enable(ctx, "fx-str");
  const path = join(ctx.pacerHome, "strategy.yaml");
  writeFileSync(path, readFileSync(path, "utf8") + "plugins:\n  disabled:\n    - fx-str\n");
  pluginRegistry(ctx).list(ctx);
  reconcilePluginWorkflowFlags(ctx);
  expect(isDefinitionDisabled(ctx, "fx-str/feature@1")).toBe(true);
  expect(await codeOf(callOp(ctx, "run.start", { workflow: "fx-str/feature@1", repo, brief: "nope" }))).toBe("not_allowed");
}, 30000);

test("out-of-band strategy.yaml re-enable allows start while disabled flag stays stale", async () => {
  const ctx = home();
  const repo = gitRepo();
  installWorkflowPlugin(ctx, "fx-oob", [{
    name: "feature", version: 1, source: MINIMAL("fx-oob/feature"), prompts: {},
  }]);
  await enable(ctx, "fx-oob");
  // Disable via the config API (strategy.yaml plugins.disabled) so the grant stays recorded.
  await setPluginDisabled(ctx, "fx-oob", true);
  pluginRegistry(ctx).list(ctx);
  reconcilePluginWorkflowFlags(ctx);
  expect(isDefinitionDisabled(ctx, "fx-oob/feature@1")).toBe(true);
  expect(await codeOf(callOp(ctx, "run.start", { workflow: "fx-oob/feature@1", repo, brief: "nope" }))).toBe("not_allowed");

  // Re-enable by editing strategy.yaml only — no plugin.enable, no sync, no restart.
  await setPluginDisabled(ctx, "fx-oob", false);
  pluginRegistry(ctx).list(ctx);
  expect(isDefinitionDisabled(ctx, "fx-oob/feature@1")).toBe(true);
  expect(await codeOf(callOp(ctx, "run.start", { workflow: "fx-oob/feature@1", repo, brief: "go" }))).toBe("no error");
  expect(isDefinitionDisabled(ctx, "fx-oob/feature@1")).toBe(false);
}, 30000);

test("exhausted sync retries still allow start once the live gate passes", async () => {
  const ctx = home();
  const repo = gitRepo();
  installWorkflowPlugin(ctx, "fx-exh", [{
    name: "feature", version: 1, source: MINIMAL("fx-exh/feature"), prompts: {},
  }]);
  await enable(ctx, "fx-exh");
  setPluginDefinitionsDisabled(ctx, "fx-exh", true);
  expect(isDefinitionDisabled(ctx, "fx-exh/feature@1")).toBe(true);

  const { Database } = await import("bun:sqlite");
  const writer = new Database(join(ctx.pacerHome, "state/tasks.db"));
  writer.exec("BEGIN IMMEDIATE");
  try {
    const deferred: Array<() => void> = [];
    // Empty retry budget: SQLITE_BUSY defers once then gives up; flag stays 1.
    await syncAllPluginWorkflows(ctx, {
      defer: work => { deferred.push(work); },
      retryDelaysMs: [],
    });
    expect(deferred.length).toBe(0);
    expect(isDefinitionDisabled(ctx, "fx-exh/feature@1")).toBe(true);
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
  // Plugin is still live; stale flag after exhausted retries must not refuse.
  expect(await codeOf(callOp(ctx, "run.start", { workflow: "fx-exh/feature@1", repo, brief: "go" }))).toBe("no error");
  expect(isDefinitionDisabled(ctx, "fx-exh/feature@1")).toBe(false);
}, 30000);

test("manual-origin disabled flag still refuses start", async () => {
  const ctx = home();
  const repo = gitRepo();
  const source = MINIMAL("hand/gate");
  const { def } = parseWorkflow(source);
  expect(def).toBeTruthy();
  addDefinition(ctx, def!, source);
  workflowDatabase(ctx).query("UPDATE workflow_defs SET disabled = 1 WHERE id = ? AND version = ?")
    .run("hand/gate", 1);
  expect(isDefinitionDisabled(ctx, "hand/gate@1")).toBe(true);
  expect(await codeOf(callOp(ctx, "run.start", { workflow: "hand/gate@1", repo, brief: "nope" }))).toBe("not_allowed");
}, 30000);

test("choose_workflow refuses a child from a disabled plugin (same not_allowed as run.start)", async () => {
  const ctx = home();
  const router = `
id: fx-ch/router
version: 1
steps:
  choose: { type: choose_workflow }
  done: { type: end }
edges: [[choose, done]]
`;
  const childSrc = MINIMAL("fx-ch/feature");
  installWorkflowPlugin(ctx, "fx-ch", [
    { name: "router", version: 1, source: router, prompts: {} },
    { name: "feature", version: 1, source: childSrc, prompts: {} },
  ], { names: ["router", "feature"] });
  await enable(ctx, "fx-ch");
  const repo = gitRepo();
  const deps = {
    ...defaultEngineDeps,
    delegate: async (c: Parameters<typeof defaultEngineDeps.delegate>[0], input: Parameters<typeof defaultEngineDeps.delegate>[1]) => {
      const { createTask } = await import("../src/tasks/store");
      return createTask(c, {
        brief: input.brief, kind: input.kind ?? null, requestedExecutor: null, timeoutS: 60,
        title: input.title, requestId: input.requestId,
      });
    },
  };
  const spawn: SpawnRunner = () => 1;
  const parent = await startRun(ctx, { workflow: "fx-ch/router@1", repo, brief: "route" }, spawn, deps);
  expect(stepsOfRun(ctx, parent.id).some(s => s.stepId === "choose" && s.status === "waiting")).toBe(true);

  await callOp(ctx, "plugin.disable", { id: "fx-ch" });
  expect(isDefinitionDisabled(ctx, "fx-ch/feature@1")).toBe(true);
  expect(await codeOf(callOp(ctx, "run.start", { workflow: "fx-ch/feature@1", repo, brief: "top" }))).toBe("not_allowed");

  const chooseCode = await codeOf(chooseWorkflow(ctx, {
    runId: parent.id, stepId: "choose", workflow: "fx-ch/feature@1", reason: "should refuse",
  }, spawn, deps));
  expect(chooseCode).toBe("not_allowed");
  // Choosing marker must not stick after a pre-claim refusal.
  const chooseRow = stepsOfRun(ctx, parent.id).find(s => s.stepId === "choose" && s.status === "waiting");
  expect(chooseRow).toBeDefined();
  expect(chooseRow!.result == null).toBe(true);
}, 60000);

test("choose_workflow refuses when the plugin grant no longer covers the target", async () => {
  const ctx = home();
  const router = `
id: fx-gr/router
version: 1
steps:
  choose: { type: choose_workflow, from: [fx-gr/feature, fx-gr/extra] }
  done: { type: end }
edges: [[choose, done]]
`;
  installWorkflowPlugin(ctx, "fx-gr", [
    { name: "router", version: 1, source: router, prompts: {} },
    { name: "feature", version: 1, source: MINIMAL("fx-gr/feature"), prompts: {} },
    { name: "extra", version: 1, source: MINIMAL("fx-gr/extra"), prompts: {} },
  ], { names: ["router", "feature", "extra"] });
  await enable(ctx, "fx-gr");
  // Drop "extra" from contributes + grant while leaving the stored def: plugin stays live,
  // but choose of extra hits the grant-cover check (not needs_grant).
  installWorkflowPlugin(ctx, "fx-gr", [
    { name: "router", version: 1, source: router, prompts: {} },
    { name: "feature", version: 1, source: MINIMAL("fx-gr/feature"), prompts: {} },
  ], { names: ["router", "feature"], version: "1.0.0" });
  await setPluginGrant(ctx, "fx-gr", {
    version: "1.0.0",
    capabilities: [],
    workflows: ["router", "feature"],
  });
  pluginRegistry(ctx).list(ctx);
  const repo = gitRepo();
  const deps = {
    ...defaultEngineDeps,
    delegate: async (c: Parameters<typeof defaultEngineDeps.delegate>[0], input: Parameters<typeof defaultEngineDeps.delegate>[1]) => {
      const { createTask } = await import("../src/tasks/store");
      return createTask(c, {
        brief: input.brief, kind: input.kind ?? null, requestedExecutor: null, timeoutS: 60,
        title: input.title, requestId: input.requestId,
      });
    },
  };
  const spawn: SpawnRunner = () => 1;
  const parent = await startRun(ctx, { workflow: "fx-gr/router@1", repo, brief: "route" }, spawn, deps);
  try {
    await chooseWorkflow(ctx, {
      runId: parent.id, stepId: "choose", workflow: "fx-gr/extra", reason: "ungranted",
    }, spawn, deps);
    expect.unreachable("expected not_allowed");
  } catch (e) {
    const err = toApiError(e);
    expect(err.code).toBe("not_allowed");
    expect(err.message).toBe("workflow 'fx-gr/extra' cannot start: plugin grant does not cover 'extra'");
  }
  const chooseRow = stepsOfRun(ctx, parent.id).find(s => s.stepId === "choose" && s.status === "waiting");
  expect(chooseRow).toBeDefined();
  expect(chooseRow!.result == null).toBe(true);
  // Positive control: the still-granted feature is choosable after the revoke of extra.
  const child = await chooseWorkflow(ctx, {
    runId: parent.id, stepId: "choose", workflow: "fx-gr/feature", reason: "covered",
  }, spawn, deps);
  expect(child.workflow).toBe("fx-gr/feature");
  expect(child.parentRunId).toBe(parent.id);
}, 60000);

test("plugin sync supersedes a stored def that no longer validates (kind review → research)", async () => {
  const ctx = home();
  const badSrc = `
id: fx-rev/feature
version: 1
steps:
  panel:
    type: fanout
    branches: [a]
    each: { kind: review, prompt: "review" }
    join: all
  done: { type: end }
edges: [[panel, done]]
`;
  const goodSrc = MINIMAL("fx-rev/feature");
  // Pre-fix home: invalid kind:review stored under plugin origin.
  const raw = {
    id: "fx-rev/feature",
    version: 1,
    steps: {
      panel: {
        type: "fanout",
        branches: ["a"],
        each: { kind: "review", prompt: "review" },
        join: "all",
      },
      done: { type: "end" },
    },
    edges: [{ from: "panel", to: "done" }],
    entry: "panel",
  };
  workflowDatabase(ctx).query(
    "INSERT INTO workflow_defs(id, version, source, def, added_at, origin, disabled) VALUES (?, ?, ?, ?, ?, ?, 0)",
  ).run("fx-rev/feature", 1, badSrc, JSON.stringify(raw), ctx.now, "plugin:fx-rev@1.0.0");

  installWorkflowPlugin(ctx, "fx-rev", [
    { name: "feature", version: 1, source: goodSrc, prompts: {} },
  ], { version: "1.0.1" });
  await enable(ctx, "fx-rev");
  const fixed = getDefinition(ctx, "fx-rev/feature@1");
  expect(fixed).toBeTruthy();
  expect((fixed!.steps.go as { kind?: string }).kind).toBe("research");
  expect(isDefinitionDisabled(ctx, "fx-rev/feature@1")).toBe(false);
}, 60000);

test("deleted plugin directory blocks new workflow starts", async () => {
  const ctx = home();
  const repo = gitRepo();
  const dir = installWorkflowPlugin(ctx, "fx-gone", [{
    name: "feature", version: 1, source: MINIMAL("fx-gone/feature"), prompts: {},
  }]);
  await enable(ctx, "fx-gone");
  await callOp(ctx, "plugin.disable", { id: "fx-gone" });
  rmSync(dir, { recursive: true, force: true });
  pluginRegistry(ctx).list(ctx);
  reconcilePluginWorkflowFlags(ctx);
  expect(await codeOf(callOp(ctx, "run.start", { workflow: "fx-gone/feature@1", repo, brief: "nope" }))).toBe("not_allowed");
}, 30000);

test("needs_grant after upgrade adding a workflow blocks run.start", async () => {
  const ctx = home();
  const repo = gitRepo();
  installWorkflowPlugin(ctx, "fx-ng", [{
    name: "feature", version: 1, source: MINIMAL("fx-ng/feature"), prompts: {},
  }], { names: ["feature"], version: "1.0.0" });
  await callOp(ctx, "plugin.enable", { id: "fx-ng", grant: true });
  await syncPluginWorkflows(ctx, "fx-ng");

  installWorkflowPlugin(ctx, "fx-ng", [{
    name: "feature", version: 1, source: MINIMAL("fx-ng/feature"), prompts: {},
  }, {
    name: "router", version: 1, source: MINIMAL("fx-ng/router"), prompts: {},
  }], { names: ["feature", "router"], version: "1.1.0" });
  pluginRegistry(ctx).list(ctx);
  const again = await callOp(ctx, "plugin.enable", { id: "fx-ng" }) as { state: string };
  expect(again.state).toBe("needs_grant");
  expect(await codeOf(callOp(ctx, "run.start", { workflow: "fx-ng/feature@1", repo, brief: "nope" }))).toBe("not_allowed");
}, 30000);

test('reply between 960 KiB and 1 MiB is refused with exact diagnostic', async () => {
  const ctx = home();
  const source = MINIMAL("fx-kib/feature", 1);
  const prompts: Record<string, string> = {};
  const transportMax = 1024 * 1024;
  let page = { workflows: [{ name: "feature" as const, version: 1, source, prompts: { ...prompts } }] };
  for (let i = 0; workflowDefinitionsReplyFits(page) && workflowDefinitionsReplyBytes(page) < transportMax - 4096; i++) {
    prompts[`p${i}.md`] = "y".repeat(50_000);
    page = { workflows: [{ name: "feature", version: 1, source, prompts: { ...prompts } }] };
  }
  expect(workflowDefinitionsReplyFits(page)).toBe(false);
  expect(workflowDefinitionsReplyBytes(page)).toBeLessThanOrEqual(transportMax);

  const hugeJson = JSON.stringify([{ name: "feature", version: 1, source, prompts }]);
  installMainTsPlugin(ctx, "fx-kib", `
import { readFileSync } from "node:fs";
import { serve, stdinLines } from "@pacer/plugin";
const manifest = JSON.parse(readFileSync("pacer-plugin.json", "utf8"));
const PAGE = JSON.parse(${JSON.stringify(hugeJson)})[0];
await serve({
  manifest, input: stdinLines(),
  handlers: {
    "diagnostic.ping": async () => ({ ok: true, uptimeS: 0 }),
    "workflow.definitions": async () => ({ workflows: [PAGE] }),
  },
});
`);
  await enable(ctx, "fx-kib");
  expect(readFileSync(pluginLogPath(ctx, "fx-kib"), "utf8")).toContain("workflow.definitions reply exceeds 960 KiB");
  expect(getDefinition(ctx, "fx-kib/feature")).toBeNull();
}, 60000);

test("running run advances next step after plugin disabled", async () => {
  const ctx = home();
  const two = `
id: fx-live/two
version: 1
steps:
  first:
    type: agent
    kind: research
    prompt: inline-a
  second:
    type: agent
    kind: research
    prompt: inline-b
  done: { type: end }
edges: [[first, second], [second, done]]
`;
  installWorkflowPlugin(ctx, "fx-live", [{
    name: "two", version: 1, source: two, prompts: {},
  }], { names: ["two"] });
  await enable(ctx, "fx-live");
  const repo = gitRepo();
  const deps = {
    ...defaultEngineDeps,
    delegate: async (c: Parameters<typeof defaultEngineDeps.delegate>[0], input: Parameters<typeof defaultEngineDeps.delegate>[1]) => {
      const { createTask } = await import("../src/tasks/store");
      return createTask(c, {
        brief: input.brief, kind: input.kind ?? null, requestedExecutor: null, timeoutS: 60,
        title: input.title, requestId: input.requestId,
      });
    },
  };
  const spawn: SpawnRunner = () => 1;
  const run = await startRun(ctx, { workflow: "fx-live/two@1", repo, brief: "go" }, spawn, deps);
  const first = stepsOfRun(ctx, run.id).find(s => s.stepId === "first")!;
  expect(first.taskId).toBeTruthy();

  await callOp(ctx, "plugin.disable", { id: "fx-live" });
  recordStepResult(ctx, first.taskId!, { ok: true });
  updateTask(ctx, first.taskId!, t => { t.state = "done"; });
  await onTaskSettled(ctx, first.taskId!, spawn, deps);

  const second = stepsOfRun(ctx, run.id).find(s => s.stepId === "second")!;
  expect(second.status).toBe("running");
  expect(second.taskId).toBeTruthy();
  expect(getRun(ctx, run.id)!.status).toBe("running");
}, 60000);
