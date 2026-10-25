import { expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { detect } from "../src/install/init";
import { detectAgents } from "../src/install/detection";
import { check, init } from "../src/core/setup";
import { fakeCtx } from "./install-plugin-fixtures";
import {withVersionFixtures} from "./planner-detect-fixtures";

// IDE/OS launchers, plus Ollama whose list command can auto-open its macOS app.
const GUI_LAUNCHERS = new Set(["cursor", "agy", "antigravity", "orca", "code", "code-insiders", "open", "ollama"]);

for (const headlessCursor of [false, true]) {
  test(`setup discovery never executes GUI launchers (headless Cursor: ${headlessCursor})`, async () => {
    const calls: string[][] = [];
    const ctx = fakeCtx({
      which: bin => bin === "cursor-agent" && !headlessCursor ? null : `/fake/${bin}`,
      run: async argv => {
        calls.push(argv);
        return { code: 0, stdout: argv[0] === "lms" ? "[]" : "1.2.3", stderr: "" };
      },
    });
    withVersionFixtures(ctx);
    const request = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ models: [] }));
    try {
      const tools = await detect(ctx);
      expect(tools.clis.cursor).toBe(ctx.which("cursor"));
      expect(tools.clis.agy).toBe("/fake/agy");
      await init(ctx, "claude-code");
      await check(ctx, { snapshotProbe: false });
      await init(ctx, "codex"); // Existing-strategy path must also stay safe.
      const agents = await detectAgents(ctx);
      expect(agents.find(a => a.agent === "cursor")).toMatchObject({
        found: true,
        path: ctx.which(headlessCursor?"cursor-agent":"cursor"),
        version: headlessCursor ? "1.2.3" : null,
      });
      expect(calls.filter(argv => GUI_LAUNCHERS.has(basename(argv[0])))).toEqual([]);
      expect(calls.filter(argv => basename(argv[0]) === "lms")).toEqual([
        ["lms", "ls", "--json", "--port", "41343"],
        ["lms", "ls", "--json", "--port", "41343"],
      ]);
      expect(calls.filter(argv => argv[1] === "--version")).toEqual([
        ["/fake/claude", "--version"],
        ["/fake/codex", "--version"],
        ...(headlessCursor ? [["/fake/cursor-agent", "--version"]] : []),
        ["/fake/opencode", "--version"],
      ]);
    } finally { request.mockRestore(); }
  });
}

test("Ollama model discovery reads the running server without spawning its launcher", async () => {
  const calls: string[][] = [];
  const ctx = fakeCtx({ which: bin => bin === "ollama" ? "/fake/ollama" : null,
    env: { OLLAMA_HOST: "127.0.0.1:11435" },
    run: async argv => { calls.push(argv); return { code: 0, stdout: "", stderr: "" }; },
  });
  const request = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ models: [{ name: "qwen:7b" }, { name: "other" }] }));
  try {
    expect((await detect(ctx)).ollamaModel).toBe("qwen:7b");
    expect(String(request.mock.calls[0][0])).toBe("http://127.0.0.1:11435/api/tags");
    expect(calls).toEqual([]);
    request.mockRejectedValue(new Error("server stopped"));
    expect((await detect(ctx)).ollamaModel).toBeNull();
    expect(calls).toEqual([]);
  } finally { request.mockRestore(); }
});

test("LM Studio discovery never retries without an explicit port when its server is stopped", async () => {
  const calls: string[][] = [];
  const ctx = fakeCtx({ which: bin => bin === "lms" ? "/fake/lms" : null,
    run: async argv => { calls.push(argv); return { code: 1, stdout: "", stderr: "server is not running" }; },
  });
  expect(await detect(ctx)).toMatchObject({ clis: { lms: "/fake/lms" }, lmstudioModel: null });
  expect(calls).toEqual([["lms", "ls", "--json", "--port", "41343"]]);
});

test("LM Studio discovery uses its published API port without launching an app", async () => {
  const calls: string[][] = [];
  const ctx = fakeCtx({ which: bin => bin === "lms" ? "/fake/lms" : null,
    run: async argv => { calls.push(argv); return { code: 0, stdout: '[{"type":"llm","modelKey":"qwen"}]', stderr: "" }; },
  });
  const dir = join(ctx.home, ".lmstudio", ".internal");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "http-server.json"), JSON.stringify({ port: 52993 }));
  expect((await detect(ctx)).lmstudioModel).toBe("qwen");
  expect(calls).toEqual([["lms", "ls", "--json", "--port", "52993"]]);
});

test("Ollama discovery preserves explicit HTTP and HTTPS default ports", async () => {
  const request = spyOn(globalThis, "fetch");
  try {
    for (const host of ["http://localhost", "https://localhost"]) {
      request.mockResolvedValue(Response.json({ models: [] }));
      await detect(fakeCtx({ which: bin => bin === "ollama" ? "/fake/ollama" : null, env: { OLLAMA_HOST: host } }));
      expect(String(request.mock.calls.at(-1)![0])).toBe(`${host}/api/tags`);
    }
  } finally { request.mockRestore(); }
});
