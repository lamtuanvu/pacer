import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync, symlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { callOp } from "../src/api/ops";
import { toApiError } from "../src/api/protocol";
import { KINDS } from "../src/config/strategy";
import { BUNDLED } from "../plugins/bundled";
import { shutdownPlugins, pluginRegistry } from "../src/plugins";
import { canAutoDecide } from "../src/workflow/auto";
import { startRun, defaultEngineDeps } from "../src/workflow/engine";
import { parseWorkflow } from "../src/workflow/parse";
import { syncPluginWorkflows } from "../src/workflow/plugin-sync";
import type { HumanStep, WorkflowDef } from "../src/workflow/schema";
import {
  getDefinition,
  getDefinitionPrompt,
  isDefinitionDisabled,
  listDefinitions,
  workflowDatabase,
} from "../src/workflow/store";
import { validateWorkflow } from "../src/workflow/validate";
import { fakeCtx, gitRepo, tmpDir } from "./helpers";

const ROOT = join(import.meta.dir, "..");
const PLUGIN_DIR = join(ROOT, "plugins/pacer-dev");
const WORKFLOWS_DIR = join(PLUGIN_DIR, "workflows");

const contexts: ReturnType<typeof fakeCtx>[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => shutdownPlugins(ctx)));
});

function home() {
  const dir = tmpDir();
  const ctx = fakeCtx({
    home: dir,
    pacerHome: join(dir, ".pacer"),
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
  try {
    await p;
    return "no error";
  } catch (e) {
    return toApiError(e).code;
  }
};

function loadYaml(name: string): string {
  return readFileSync(join(WORKFLOWS_DIR, name), "utf8");
}

function assertValid(source: string): WorkflowDef {
  const { def, errors } = parseWorkflow(source);
  expect(errors).toEqual([]);
  expect(def).toBeTruthy();
  expect(validateWorkflow(def!)).toEqual([]);
  return def!;
}

function humanSteps(def: WorkflowDef): [string, HumanStep][] {
  return Object.entries(def.steps).filter((e): e is [string, HumanStep] => e[1].type === "human");
}

function promptPathsOnDisk(): Set<string> {
  const files = readdirSync(join(PLUGIN_DIR, "prompts"));
  return new Set(files.map(f => `prompts/${f}`));
}

test("every shipped YAML validates; prompt paths exist; publish is must-only; kinds are known", () => {
  const known = new Set<string>(KINDS);
  const onDisk = promptPathsOnDisk();
  const files = readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith(".yaml"));
  expect(files.length).toBeGreaterThanOrEqual(5);

  for (const file of files) {
    const def = assertValid(loadYaml(file));
    expect(def.id.startsWith("pacer-dev/")).toBe(true);

    for (const [id, step] of Object.entries(def.steps)) {
      if (step.type === "agent") {
        if (typeof step.kind === "string") {
          expect(known.has(step.kind), `${file} steps.${id}.kind=${step.kind}`).toBe(true);
        }
        if (!step.prompt.includes("\n") && step.prompt.startsWith("prompts/")) {
          expect(onDisk.has(step.prompt)).toBe(true);
        }
      } else if (step.type === "generate") {
        if (!step.prompt.includes("\n") && step.prompt.startsWith("prompts/")) {
          expect(onDisk.has(step.prompt)).toBe(true);
        }
        if (step.limits?.kinds) {
          for (const k of step.limits.kinds) {
            expect(known.has(k), `${file} steps.${id}.limits.kinds has ${k}`).toBe(true);
          }
        }
      } else if (step.type === "fanout") {
        const eachKind = step.each.kind;
        expect(typeof eachKind === "string" && known.has(eachKind), `${file} steps.${id}.each.kind=${eachKind}`).toBe(true);
        if (step.each.prompt.startsWith("prompts/")) {
          expect(onDisk.has(step.each.prompt)).toBe(true);
        }
      }
    }

    for (const [id, step] of humanSteps(def)) {
      if (step.approves === "publish") {
        expect(step.decision ?? "must").toBe("must");
        expect(["yes_no", "approve_revise"]).toContain(step.question.kind);
      }
      // No must step is answerable in auto mode.
      if ((step.decision ?? "must") === "must") {
        const fakeRun = { auto: true, strictSteps: [] as string[] } as Parameters<typeof canAutoDecide>[0];
        expect(canAutoDecide(fakeRun, id, step)).toBe(false);
      }
    }
  }
});

test("structural assertions: router, feature@1, feature@2, bug@1, ask@1", () => {
  const router = assertValid(loadYaml("router.yaml"));
  expect(router).toMatchObject({ id: "pacer-dev/router", version: 1 });
  expect(router.steps.choose).toMatchObject({ type: "choose_workflow" });
  expect(router.steps.done).toMatchObject({ type: "end" });
  // Unrestricted choose picks from the installed workflow list.
  expect((router.steps.choose as { from?: string[] }).from).toBeUndefined();

  const feature1 = assertValid(loadYaml("feature.yaml"));
  expect(feature1).toMatchObject({ id: "pacer-dev/feature", version: 1 });
  expect(feature1.steps.brainstorm).toMatchObject({
    type: "agent", role: "orchestrator", interactive: true,
  });
  expect(feature1.steps.approve_spec).toMatchObject({
    type: "human", decision: "must", question: { kind: "approve_revise" },
  });
  expect(feature1.steps.review).toMatchObject({
    type: "fanout",
    branches: ["architecture", "devils-advocate", "ux", "security"],
    each: { type: "agent", kind: "research" },
    join: "all",
  });
  expect(feature1.steps.implement).toMatchObject({ type: "agent", kind: "feature", code: true });
  expect(feature1.steps.code_review).toMatchObject({ type: "agent", role: "reviewer" });
  expect(feature1.steps.test).toMatchObject({
    type: "agent", kind: "tests", result: "evidence", needs: ["browser"],
  });
  expect(feature1.steps.approve_publish).toMatchObject({
    type: "human", decision: "must", approves: "publish",
  });
  expect(feature1.steps.open_pr).toMatchObject({ type: "agent", role: "orchestrator" });
  expect(feature1.steps).not.toHaveProperty("plan");

  const feature2 = assertValid(loadYaml("feature-v2.yaml"));
  expect(feature2).toMatchObject({ id: "pacer-dev/feature", version: 2 });
  expect(feature2.steps.plan).toMatchObject({
    type: "generate",
    role: "orchestrator",
    approval: "auto",
    limits: { require_last: { kind: "tests" } },
  });
  expect(feature2.steps).not.toHaveProperty("implement");
  expect(feature2.steps).not.toHaveProperty("code_review");

  const bug = assertValid(loadYaml("bug.yaml"));
  expect(bug).toMatchObject({ id: "pacer-dev/bug", version: 1 });
  expect(bug.steps.investigate).toMatchObject({ type: "agent", kind: "research", code: false });
  expect(bug.steps.reproduce_or_fix).toMatchObject({ type: "agent", code: true });
  expect(bug.steps.approve_publish).toMatchObject({ approves: "publish", decision: "must" });

  const ask = assertValid(loadYaml("ask.yaml"));
  expect(ask).toMatchObject({ id: "pacer-dev/ask", version: 1 });
  expect(ask.steps.answer).toMatchObject({ type: "agent", role: "orchestrator", code: false });
  expect(ask.steps.approve_answer).toMatchObject({ type: "human", question: { kind: "approve_revise" } });
  expect(Object.values(ask.steps).some(s => s.type === "human" && "approves" in s && s.approves === "publish")).toBe(false);
});

test("frame source (src/workflow) never names pacer-dev", () => {
  const dir = join(ROOT, "src/workflow");
  const hits: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ts")) continue;
    const text = readFileSync(join(dir, name), "utf8");
    if (text.includes("pacer-dev")) hits.push(name);
  }
  expect(hits).toEqual([]);
});

test("bundled pacer-dev is registered with workflow contributes", () => {
  const entry = BUNDLED.find(b => b.manifest.id === "pacer-dev");
  expect(entry).toBeTruthy();
  expect(entry!.manifest.host).toMatch(/1\.12/);
  // Do not toMatchObject the live BUNDLED manifest: bun:test mutates nested
  // objects under expect.anything(), which breaks later structuredClone/start.
  expect(Object.keys(entry!.manifest.contributes.workflow ?? {}).sort()).toEqual([
    "ask", "bug", "feature", "router",
  ]);
  expect(entry!.main).toBeTypeOf("function");
});

test("plugin sync stores all pages with origin; re-sync is a no-op; disable pins live runs", async () => {
  const ctx = home();
  const listed = pluginRegistry(ctx).list(ctx).find(p => p.id === "pacer-dev");
  expect(listed).toMatchObject({
    bundled: true, enabled: true, contributes: expect.arrayContaining(["workflow"]),
  });

  await syncPluginWorkflows(ctx, "pacer-dev");

  const defs = listDefinitions(ctx).filter(d => d.id.startsWith("pacer-dev/"));
  expect(defs.map(d => `${d.id}@${d.version}`).sort()).toEqual([
    "pacer-dev/ask@1",
    "pacer-dev/bug@1",
    "pacer-dev/feature@1",
    "pacer-dev/feature@2",
    "pacer-dev/router@1",
  ]);
  for (const d of defs) {
    expect(d.origin).toBe("plugin:pacer-dev@1.0.1");
    expect(d.disabled).toBe(false);
    expect(getDefinition(ctx, `${d.id}@${d.version}`)).not.toBeNull();
  }

  // Two-page (and multi-page) paging: host followed next through every page.
  expect(getDefinition(ctx, "pacer-dev/router@1")).not.toBeNull();
  expect(getDefinition(ctx, "pacer-dev/ask@1")).not.toBeNull();

  const before = workflowDatabase(ctx).query(
    "SELECT COUNT(*) AS n FROM workflow_defs WHERE id LIKE 'pacer-dev/%'",
  ).get() as { n: number };
  await syncPluginWorkflows(ctx, "pacer-dev");
  const after = workflowDatabase(ctx).query(
    "SELECT COUNT(*) AS n FROM workflow_defs WHERE id LIKE 'pacer-dev/%'",
  ).get() as { n: number };
  expect(after.n).toBe(before.n);

  const repo = gitRepo();
  const run = await startRun(ctx, { workflow: "pacer-dev/router@1", repo, brief: "route me" }, undefined, {
    ...defaultEngineDeps,
    delegate: async (c, input) => {
      const { createTask } = await import("../src/tasks/store");
      return createTask(c, {
        brief: input.brief, kind: input.kind ?? null, requestedExecutor: null, timeoutS: 60,
        title: input.title, requestId: input.requestId,
      });
    },
  });
  expect(run.status === "running" || run.status === "waiting").toBe(true);

  await callOp(ctx, "plugin.disable", { id: "pacer-dev" });
  expect(isDefinitionDisabled(ctx, "pacer-dev/router@1")).toBe(true);
  expect(await codeOf(callOp(ctx, "run.start", {
    workflow: "pacer-dev/feature@1", repo, brief: "nope",
  }))).toBe("not_allowed");

  // Pinned definition still resolves for the live run.
  expect(getDefinition(ctx, "pacer-dev/router@1")).not.toBeNull();
  expect(workflowDatabase(ctx).query("SELECT status FROM workflow_runs WHERE id = ?").get(run.id)).toMatchObject({
    status: expect.stringMatching(/running|waiting/),
  });
}, 90000);

test("compiled pacer-dev embeds YAML and prompts without runtime FS reads", async () => {
  const { cpSync, mkdtempSync, renameSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  // Copy the plugin outside the repo and hide sources only in that copy — never mutate the checkout.
  const scratch = mkdtempSync(join(tmpdir(), "pacer-dev-embed-"));
  const pluginCopy = join(scratch, "plugin");
  const outDir = join(scratch, "out");
  mkdirSync(outDir, { recursive: true });
  cpSync(PLUGIN_DIR, pluginCopy, { recursive: true });
  symlinkSync(join(ROOT, "node_modules"), join(scratch, "node_modules"), "dir");
  const outfile = join(outDir, "bundle.mjs");
  const build = Bun.spawnSync(
    [process.execPath, "build", join(pluginCopy, "index.ts"), "--outfile", outfile, "--target", "bun"],
    { cwd: scratch },
  );
  expect(build.exitCode).toBe(0);
  expect(existsSync(outfile)).toBe(true);

  const prompts = join(pluginCopy, "prompts");
  const workflows = join(pluginCopy, "workflows");
  renameSync(prompts, join(pluginCopy, ".prompts-hidden-test"));
  renameSync(workflows, join(pluginCopy, ".workflows-hidden-test"));
  try {
    const previous = process.cwd();
    process.chdir(outDir);
    try {
      const mod = await import(outfile + `?t=${Date.now()}`);
      const handler = mod.handlers["workflow.definitions"] as (
        params: { after?: string },
        host: unknown,
        signal: AbortSignal,
      ) => Promise<{ workflows: { name: string; version: number; source: string; prompts: Record<string, string> }[]; next?: string }>;
      expect(handler).toBeTypeOf("function");
      const seen: string[] = [];
      const allPrompts = new Set<string>();
      let after: string | undefined;
      for (let i = 0; i < 8; i++) {
        const page = await handler(after ? { after } : {}, {}, new AbortController().signal);
        for (const w of page.workflows) {
          seen.push(`${w.name}@${w.version}`);
          expect(w.source.length).toBeGreaterThan(20);
          expect(w.source).toContain("id:");
          for (const [path, text] of Object.entries(w.prompts)) {
            allPrompts.add(path);
            expect(text.length).toBeGreaterThan(10);
          }
        }
        if (!page.next) break;
        after = page.next;
      }
      expect(seen.sort()).toEqual([
        "ask@1", "bug@1", "feature@1", "feature@2", "router@1",
      ].sort());
      expect(allPrompts.has("prompts/open-pr.md")).toBe(true);
      expect(allPrompts.has("prompts/orchestrator.md")).toBe(true);
      expect(allPrompts.has("prompts/implement.md")).toBe(true);
    } finally {
      process.chdir(previous);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 60000);

test("open-pr and questions prompt CLI lines parse to the documented ops", async () => {
  const { commandArgs } = await import("../src/commands/accounts");
  const { runCmd } = await import("../src/commands/run");
  const { main } = await import("../src/cli");
  const { createTask, updateTask } = await import("../src/tasks/store");
  const { addDefinition, insertRun, insertStep } = await import("../src/workflow/store");
  const { insertTurn } = await import("../src/workflow/wakeups");
  const { issueRunGrant } = await import("../src/workflow/run-grant");
  const { parseWorkflow } = await import("../src/workflow/parse");

  const openPr = readFileSync(join(PLUGIN_DIR, "prompts/open-pr.md"), "utf8");
  const questions = readFileSync(join(PLUGIN_DIR, "prompts/questions.md"), "utf8");
  const publishLine = openPr.match(/pacer run publish[^\n]+/)?.[0];
  const askLine = questions.match(/pacer ask --type[^\n]+/)?.[0];
  const answerLine = questions.match(/pacer answer[^\n]+/)?.[0];
  expect(publishLine).toBeTruthy();
  expect(askLine).toBeTruthy();
  expect(answerLine).toBeTruthy();

  const bodyFile = join(tmpDir(), "pr-body.md");
  writeFileSync(bodyFile, "Evidence summary for the PR.\n");
  // Valid run id shape (base32 Crockford) so parse reaches run.get, not zod id check.
  const publishRunId = "run_abcdefghij";
  const title = "Short PR title";
  // Documented shape: pacer run publish <id> --title ... --body-file ... [--draft]
  expect(publishLine!).toContain("pacer run publish <runId>");
  expect(publishLine!).toContain("--title");
  expect(publishLine!).toContain("--body-file");
  expect(publishLine!).toMatch(/\[--draft\]/);
  const publishArgs = ["publish", publishRunId, "--title", title, "--body-file", bodyFile, "--draft"];
  const parsedPublish = commandArgs(publishArgs.slice(1), ["title", "body-file"], ["json", "draft"]);
  expect(parsedPublish.pos).toEqual([publishRunId]);
  expect(parsedPublish.flags).toEqual({ title, "body-file": bodyFile, draft: true });

  const ctx = home();
  ctx.env.PACER_API = "inprocess";
  const publishOut = await runCmd(publishArgs, ctx, {});
  expect(publishOut.err).not.toMatch(/^usage:/i);
  // Parsed into run.get / run.publish — unknown id, not USAGE.
  expect(publishOut.code).toBe(2);
  expect(publishOut.err.toLowerCase()).toMatch(/not_found|unknown/);

  // questions.md ask/answer → real CLI parsing (src/cli.ts structured ask + answer).
  expect(askLine!).toContain("pacer ask --type <kind>");
  expect(askLine!).toContain("--step <id>");
  expect(answerLine!).toContain("pacer answer q_<id>");
  const source = MINIMAL_ASK();
  const { def } = parseWorkflow(source);
  expect(def).toBeTruthy();
  addDefinition(ctx, def!, source);
  const run = insertRun(ctx, {
    workflow: def!.id, version: def!.version, repo: gitRepo(), brief: "cli parse", title: "CLI",
  });
  const task = createTask(ctx, {
    brief: { goal: "Ask", repo: run.repo }, kind: "research", requestedExecutor: null, timeoutS: 60,
  });
  updateTask(ctx, task.id, t => { t.state = "running"; });
  insertStep(ctx, { runId: run.id, stepId: "approve", attempt: 1, taskId: task.id, status: "running" });
  const turnId = `turn_${run.id.slice(-6)}`;
  insertTurn(ctx, {
    id: turnId, runId: run.id, planner: "claude-code", status: "running",
    startedAt: ctx.now, deadline: ctx.now + 1200,
  });
  const bearer = issueRunGrant(ctx, { runId: run.id, turnId, deadline: ctx.now + 600 });
  const orchCtx = {
    ...ctx,
    env: { ...ctx.env, PACER_ROLE: "orchestrator", PACER_RUN_GRANT: bearer, PACER_API: "inprocess" },
  };
  const askResult = await main(
    ["ask", "--type", "yes_no", "--option", "yes", "--option", "no", "--recommend", "yes",
      "--blocks", "step", "--step", "approve", "--attempt", "1", "Ship it?"],
    orchCtx,
  );
  expect(askResult.err).not.toMatch(/usage:/i);
  expect(askResult.code).toBe(0);
  const asked = JSON.parse(askResult.out) as {
    id: string; rev: number; text: string; answerType: string; blocks: string; stepId?: string; attempt?: number;
    options?: { value: string }[]; recommended?: string;
  };
  expect(asked).toMatchObject({
    text: "Ship it?", answerType: "yes_no", blocks: "step",
    stepId: "approve", attempt: 1, recommended: "yes",
  });
  expect(asked.id.startsWith("q_")).toBe(true);
  expect(asked.options?.map(o => o.value)).toEqual(["yes", "no"]);

  // Orchestrator-asked questions are person-answerable (questions.md `pacer answer q_<id>`).
  const personCtx = { ...ctx, env: { ...ctx.env, PACER_API: "inprocess" } };
  const answerResult = await main(
    ["answer", asked.id, "yes", "--note", "looks good", "--expect-rev", String(asked.rev)],
    personCtx,
  );
  expect(answerResult.err).not.toMatch(/usage:/i);
  expect(answerResult.code).toBe(0);
  const answered = JSON.parse(answerResult.out) as { id: string; answer?: string; note?: string };
  expect(answered.id).toBe(asked.id);
}, 60000);

function MINIMAL_ASK(): string {
  return `
id: t/cliparse
version: 1
steps:
  approve: { type: agent, kind: research, prompt: Ask }
  done: { type: end }
edges: [[approve, done]]
`;
}

test("agent step prompts include shared data-marker and real-install rules", async () => {
  const ctx = home();
  await syncPluginWorkflows(ctx, "pacer-dev");
  const paths = ["prompts/implement.md", "prompts/open-pr.md", "prompts/investigate.md", "prompts/ask.md"];
  for (const path of paths) {
    const text = getDefinitionPrompt(ctx, "pacer-dev/feature", 1, path)
      ?? getDefinitionPrompt(ctx, "pacer-dev/bug", 1, path)
      ?? getDefinitionPrompt(ctx, "pacer-dev/ask", 1, path);
    expect(text, path).toBeTruthy();
    expect(text!).toContain("Data-marker rule");
    expect(text!).toContain("Real-install rule");
    expect(text!).toContain("Never touch the person's real pacer install");
  }
}, 60000);

test("approve_publish revise edges are wired on shipped feature workflows", async () => {
  const ctx = home();
  await syncPluginWorkflows(ctx, "pacer-dev");
  const feature = getDefinition(ctx, "pacer-dev/feature@1")!;
  const feature2 = getDefinition(ctx, "pacer-dev/feature@2")!;
  const bug = getDefinition(ctx, "pacer-dev/bug@1")!;
  for (const def of [feature, feature2, bug]) {
    const edges = def.edges ?? [];
    const publish = edges.filter(e => e.from === "approve_publish");
    expect(publish.some(e => e.to === "open_pr" && e.when?.includes("approve"))).toBe(true);
    expect(publish.some(e => e.when?.includes("revise"))).toBe(true);
  }
  const featurePublish = feature.edges!.filter(e => e.from === "approve_publish");
  expect(featurePublish.find(e => e.to === "test")?.when).toMatch(/revise/);
}, 60000);
