import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateStrategy } from "../src/config/strategy";
import { detect, initCmd, starterStrategy } from "../src/install/init";
import * as fsx from "../src/install/fsx";
import { fakeCtx } from "./helpers";

function detectedCtx(bins: string[], models = true) {
  return fakeCtx({
    which: (bin) => bins.includes(bin) ? `/fake/${bin}` : null,
    run: async (argv, timeout) => {
      expect(timeout).toBe(5000);
      if (argv[0] === "ollama") {
        expect(argv).toEqual(["ollama", "list"]);
        return { code: 0, stdout: models ? 'NAME ID SIZE MODIFIED\nqwen:7b abc 4GB now\nother xyz 1GB now\n' : "NAME ID SIZE MODIFIED\n", stderr: "" };
      }
      expect(argv).toEqual(["lms", "ls", "--json"]);
      return { code: 0, stdout: JSON.stringify(models ? [
        { type: "embedding", modelKey: "embed", trainedForToolUse: true },
        { type: "llm", modelKey: "plain", trainedForToolUse: false },
        { type: "llm", modelKey: 'tool:"model"', trainedForToolUse: true },
      ] : []), stderr: "" };
    },
  });
}

test("init writes valid detected providers and JSON-quoted models in executor order", async () => {
  const ctx = detectedCtx(["claude", "codex", "cursor-agent", "agy", "opencode", "arkcli", "ollama", "lms", "orca"]);
  const result = await initCmd(ctx, {});
  expect(result.code).toBe(0);
  const path = join(ctx.pacerHome, "strategy.yaml");
  const text = readFileSync(path, "utf8");
  const s = validateStrategy(Bun.YAML.parse(text), path);
  expect(s.planner.agent).toBe("claude-code");
  expect(s.providers.codex.usage).toBe("quota");
  expect(s.providers.codex.allowPaid).toBe(false);
  expect(s.providers.cursor.usage).toBe("reactive");
  expect(s.providers.cursor.cooldownS).toBe(21600);
  expect(s.providers.agy.usage).toBe("reactive");
  expect(s.providers.agy.cooldownS).toBe(21600);
  expect(s.providers["claude-code"].usage).toBe("quota");
  expect(s.providers["opencode#byteplus"].model).toBe("coding-plan/dola-seed-2.0-code");
  expect(s.providers["opencode#byteplus"].quotaSource).toBe("arkcli");
  expect(s.providers["opencode#ollama"].model).toBe("ollama/qwen:7b");
  expect(s.providers["opencode#lmstudio"].model).toBe('lmstudio/tool:"model"');
  expect(s.providers["opencode#ollama"].usage).toBe("unmetered");
  expect(s.providers["opencode#lmstudio"].usage).toBe("unmetered");
  expect(text).toContain('model: "ollama/qwen:7b"');
  expect(s.pacing.policy).toBe("priority");
  expect(s.pacing.plannerReserve).toBe(15);
  expect(s.routing).toEqual([{ kinds: null, executors: ["codex", "cursor", "agy", "opencode#byteplus", "opencode#ollama", "opencode#lmstudio"] }]);
  expect(result.out).toContain("orca");
});

test("init omits missing CLIs and reports both detected and missing including orca", async () => {
  const ctx = detectedCtx(["codex", "cursor-agent"]);
  const result = await initCmd(ctx, {});
  expect(result.code).toBe(0);
  const s = validateStrategy(Bun.YAML.parse(readFileSync(join(ctx.pacerHome, "strategy.yaml"), "utf8")), "/test");
  expect(s.planner.agent).toBe("codex");
  expect(Object.keys(s.providers)).toEqual(["codex", "cursor"]);
  expect(s.routing[0].executors).toEqual(["cursor"]);
  expect(result.out).toContain("Detected: codex, cursor-agent");
  expect(result.out).toContain("Missing: claude, cursor, agy, opencode, arkcli, ollama, lms, orca");
});

test("explicit planner overrides discovery priority and is excluded from routing", async () => {
  const d = await detect(detectedCtx(["claude", "codex"]));
  const s = validateStrategy(Bun.YAML.parse(starterStrategy(d, "codex")), "/test");
  expect(s.planner.agent).toBe("codex");
  expect(s.routing[0].executors).toEqual(["claude-code"]);
  expect(validateStrategy(Bun.YAML.parse(starterStrategy(d, "cursor")), "/test").planner.agent).toBe("cursor");
});

test("LM Studio falls back to first llm and local providers require opencode and a model", async () => {
  const ctx = detectedCtx(["opencode", "lms"]);
  ctx.run = async () => ({ code: 0, stdout: JSON.stringify([
    { type: "embedding", modelKey: "embed" }, { type: "llm", modelKey: "first" }, { type: "llm", modelKey: "second" },
  ]), stderr: "" });
  const d = await detect(ctx);
  expect(d.lmstudioModel).toBe("first");
  const noModels = await detect(detectedCtx(["claude", "codex", "opencode", "ollama", "lms"], false));
  const s = validateStrategy(Bun.YAML.parse(starterStrategy(noModels)), "/test");
  expect(Object.keys(s.providers)).toEqual(["claude-code", "codex"]);
  const noOpencode = await detect(detectedCtx(["claude", "codex", "arkcli", "ollama", "lms"]));
  expect(Object.keys(validateStrategy(Bun.YAML.parse(starterStrategy(noOpencode)), "/test").providers)).toEqual(["claude-code", "codex"]);
});

test("existing strategy is unchanged without force and force creates collision-safe backups", async () => {
  const ctx = detectedCtx(["claude", "codex"]);
  mkdirSync(ctx.pacerHome, { recursive: true });
  const path = join(ctx.pacerHome, "strategy.yaml");
  const old = "# original\nplanner: custom\n";
  writeFileSync(path, old);
  const refused = await initCmd(ctx, {});
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("already exists; use --force");
  expect(readFileSync(path, "utf8")).toBe(old);
  expect(readdirSync(ctx.pacerHome)).toEqual(["strategy.yaml"]);
  expect((await initCmd(ctx, { force: true })).code).toBe(0);
  const backup = readdirSync(ctx.pacerHome).find((name) => name.includes(".pacer-bak-"))!;
  expect(backup).toMatch(/^strategy\.yaml\.pacer-bak-\d{8}-\d{6}$/);
  expect(readFileSync(join(ctx.pacerHome, backup), "utf8")).toBe(old);
  const generated = readFileSync(path, "utf8");
  expect((await initCmd(ctx, { force: true })).code).toBe(0);
  expect(readFileSync(join(ctx.pacerHome, `${backup}-2`), "utf8")).toBe(generated);
});

test("no planner and planner-only detection write valid starters", async () => {
  for (const bins of [[], ["agy"], ["claude"], ["opencode"]]) {
    const ctx = detectedCtx(bins);
    expect((await initCmd(ctx)).code).toBe(0);
    validateStrategy(Bun.YAML.parse(readFileSync(join(ctx.pacerHome, "strategy.yaml"), "utf8")), "/test");
  }
});

test("forced init copies the original to the shared backup helper destination", async () => {
  const ctx = detectedCtx(["claude", "codex"]);
  mkdirSync(ctx.pacerHome, { recursive: true });
  const path = join(ctx.pacerHome, "strategy.yaml");
  writeFileSync(path, "original strategy");
  const destination = join(ctx.pacerHome, "shared-backup");
  const backup = spyOn(fsx, "backupPath").mockImplementation((file, now) => {
    if (file !== path || now !== ctx.now) throw new Error("wrong backup context");
    return destination;
  });
  try {
    const result = await initCmd(ctx, { force: true });
    expect(result.code).toBe(0);
    expect(existsSync(destination)).toBe(true);
    expect(readFileSync(destination, "utf8")).toBe("original strategy");
    expect(result.out).toContain(`Backup: ${destination}\n`);
  } finally {
    backup.mockRestore();
  }
});
