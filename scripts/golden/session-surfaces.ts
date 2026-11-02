/** Async reference observations: actual CLI dispatch, terminal launch and HTTP auth/routes. */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "../../test/helpers";
import { main } from "../../src/cli";
import { openInTerminal } from "../../src/terminal/open";
import { startServer } from "../../src/serve/http";
import { createSession } from "../../src/serve/app-auth";
import { createTask, updateTask } from "../../src/tasks/store";
export async function recordSurfaces() {
  const ctx = fakeCtx(),
    cli = [];
  const task = createTask(ctx, {
    brief: { goal: "fixture", repo: ctx.home },
    kind: null,
    requestedExecutor: null,
    timeoutS: 10,
  });
  updateTask(ctx, task.id, (t) => {
    t.state = "done";
  });
  const norm = (s: string) =>
    s
      .replaceAll(task.id, "<task>")
      .replaceAll(ctx.pacerHome, "<pacerHome>")
      .replaceAll(ctx.home, "<home>");
  const args = [
    ["attach"],
    ["attach", "a", "b"],
    ["attach", "t", "--bad"],
    ["attach", "t", "--attempt"],
    ["attach", "t", "--attempt", "0"],
    ["attach", "t", "--attempt", "01"],
    ["attach", "t", "--attempt", "1.0"],
    ["attach", "t", "--open", "bad"],
    ["attach", "unknown"],
    ["attach", task.id, "--open"],
    ["attach", task.id, "--open", "tmux"],
    ["attach", task.id],
    ["takeover"],
    ["takeover", "a", "--bad"],
    ["takeover", "unknown", "--no-attach"],
    ["takeover", task.id, "--no-attach"],
    ["session", "start"],
    ["session", "resume", task.id],
    ["session", "start", "--", "work"],
  ];
  for (const argv of args) {
    const result = await main(argv, ctx);
    cli.push({
      args: argv.map(norm),
      result: { ...result, out: norm(result.out), err: norm(result.err) },
    });
  }
  const terminal = [];
  for (const platform of ["darwin", "linux", "win32"] as const)
    for (const target of ["auto", "terminal", "tmux", "orca"] as const) {
      const ctx = fakeCtx({ env: { SSH_CONNECTION: "fixture" } }),
        calls: string[][] = [];
      const result = await openInTerminal(
        ctx,
        {
          argv: ["codex", "login"],
          env: { EXAMPLE: "a b" },
          title: "Fixture",
          target,
        },
        {
          platform,
          env: { TMUX: "yes" },
          which: () => "/fake",
          orcaAvailable: async () => true,
          run: async (argv) => {
            calls.push(
              argv.map((a) =>
                a
                  .replaceAll(ctx.pacerHome, "<pacerHome>")
                  .replace(/[0-9a-f]{8}-[0-9a-f-]{27}\.sh/g, "<script>.sh"),
              ),
            );
            if (argv[0] === "orca")
              return {
                code: 0,
                stdout: JSON.stringify({
                  ok: true,
                  result: {
                    worktree: { id: "work" },
                    terminal: { handle: "term" },
                  },
                }),
                stderr: "",
              };
            return { code: 0, stdout: "", stderr: "" };
          },
        },
      );
      terminal.push({ platform, target, result, calls });
    }
  const terminalBranches = [];
  for (const scenario of [
    "fallback-tmux",
    "headless",
    "failed-launch",
    "no-orca-handle",
    "invalid-env",
    "empty-argv",
    "custom-template",
    "linux-ghostty",
    "linux-wezterm",
    "linux-kitty",
    "linux-alacritty",
    "linux-gnome-terminal",
    "linux-x-terminal-emulator",
  ]) {
    const ctx = fakeCtx({ env: { SSH_CONNECTION: "fixture" } }),
      calls: string[][] = [];
    const setting = scenario.startsWith("linux-")
      ? scenario.slice(6)
      : scenario === "custom-template"
        ? 'custom "{cmd}" --title "a b"'
        : undefined;
    if (setting) {
      mkdirSync(ctx.pacerHome, { recursive: true });
      writeFileSync(
        join(ctx.pacerHome, "strategy.yaml"),
        JSON.stringify({ terminal: { open: setting } }),
      );
    }
    try {
      const result = await openInTerminal(
        ctx,
        {
          argv: scenario === "empty-argv" ? [] : ["codex", "login"],
          env: scenario === "invalid-env" ? { "BAD-NAME": "x" } : {},
          title: "Fixture",
          target: scenario === "no-orca-handle" ? "orca" : "auto",
        },
        {
          platform: "linux",
          env: { TMUX: "session" },
          which: () => (scenario === "headless" ? null : "/fake"),
          orcaAvailable: async () => scenario === "no-orca-handle",
          run: async (argv) => {
            calls.push(
              argv.map((a) =>
                a
                  .replaceAll(ctx.pacerHome, "<pacerHome>")
                  .replace(/[0-9a-f]{8}-[0-9a-f-]{27}\.sh/g, "<script>.sh"),
              ),
            );
            if (argv[0] === "orca")
              return {
                code: 0,
                stdout: JSON.stringify({
                  ok: true,
                  result: { worktree: { id: "work" } },
                }),
                stderr: "",
              };
            return {
              code:
                scenario === "failed-launch" ||
                (scenario === "fallback-tmux" && argv[0] !== "tmux")
                  ? 1
                  : 0,
              stdout: "",
              stderr: "",
            };
          },
        },
      );
      terminalBranches.push({ scenario, result, calls });
    } catch (error) {
      terminalBranches.push({
        scenario,
        error: (error as Error).message,
        calls,
      });
    }
  }
  const auth = [];
  const server = startServer(() => ctx, { port: 0, pumpMs: 0 }),
    base = `http://127.0.0.1:${server.port}`,
    cookie = `pacer_session=${createSession(ctx)}`;
  try {
    for (const path of [
      "/v2/tasks/unknown/session",
      "/v3/tasks/unknown/session",
      "/v3/terminals/00000000-0000-0000-0000-000000000000/session",
    ])
      for (const mode of [
        "none",
        "bearer",
        "cookie-no-origin",
        "cookie-origin",
        "cookie-cross",
        "grant",
      ] as const) {
        const headers: Record<string, string> =
          mode === "bearer"
            ? { authorization: `Bearer ${server.token}` }
            : mode === "grant"
              ? { authorization: "Bearer pwg_" + "a".repeat(64) }
              : mode.startsWith("cookie")
                ? {
                    cookie,
                    ...(mode === "cookie-origin"
                      ? { origin: base }
                      : mode === "cookie-cross"
                        ? { origin: "http://evil.invalid" }
                        : {}),
                  }
                : {};
        const res = await fetch(base + path, { headers });
        auth.push({ path, mode, status: res.status, body: await res.text() });
      }
  } finally {
    server.stop();
  }
  return { cli, terminal, terminalBranches, auth };
}
if (import.meta.main)
  writeFileSync(
    new URL(
      "../../test/fixtures/sessions/surfaces-parity.json",
      import.meta.url,
    ),
    JSON.stringify(await recordSurfaces(), null, 2) + "\n",
  );
