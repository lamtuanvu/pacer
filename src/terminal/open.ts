import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { strategyPath } from "../config/strategy";
import { CoreError } from "../core/errors";
import { OrcaClient, isReady } from "../exec/orca/client";
import { shellCommand } from "../install/fsx";
import type { Ctx, RunFn } from "../types";

export interface TerminalDeps {
  platform: NodeJS.Platform;
  which: Ctx["which"];
  run: RunFn;
  orcaAvailable(): Promise<boolean>;
  env: Ctx["env"];
}
type Target = "orca" | "terminal" | "tmux";
export interface TerminalOptions {
  argv: string[];
  env?: Record<string, string>;
  title: string;
  target?: "auto" | Target;
  worktree?: string;
}
/** Open only pacer-built argv; return the same copyable command on headless hosts. */
export async function openInTerminal(ctx: Ctx, o: TerminalOptions, deps: Partial<TerminalDeps> = {}): Promise<{ opened: boolean; target: Target | "none"; command: string }> {
  if (!o.argv.length) throw new CoreError("invalid_input", "terminal command is empty");
  const d: TerminalDeps = { platform: process.platform, which: ctx.which, run: ctx.run, env: ctx.env, orcaAvailable: async () => {
    if (!d.which("orca")) return false;
    return isReady(await new OrcaClient(d.run, d.env).status());
  }, ...deps };
  const assignments = Object.entries(o.env ?? {}).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new CoreError("invalid_input", "invalid environment variable name");
    return `${name}=${shellCommand([value])}`;
  });
  const command = [...assignments, shellCommand(o.argv)].join(" ");
  const dir = join(ctx.pacerHome, "terminal");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const file of readdirSync(dir).filter(f => /^[a-zA-Z0-9-]+\.sh$/.test(f))) {
    const path = join(dir, file);
    try { if (Date.now() - statSync(path).mtimeMs >= 3600000) rmSync(path, { force: true }); } catch { /* already removed */ }
  }
  const script = join(dir, `${randomUUID()}.sh`);
  writeFileSync(script, `#!/bin/sh\n${command}\n`, { mode: 0o700 });
  chmodSync(script, 0o700);
  const cleanup = setTimeout(() => { try { rmSync(script, { force: true }); } catch { /* removed on next open */ } }, 3600000);
  cleanup.unref();
  const targets: Target[] = !o.target || o.target === "auto" ? ["orca", "terminal", "tmux"] : [o.target];
  for (const target of targets) {
    try {
      if (target === "orca") {
        if (!await d.orcaAvailable()) continue;
        const client = new OrcaClient(d.run, d.env);
        let selector = o.worktree;
        if (!selector) {
          const focused = await client.call<{ worktree?: { id?: string } }>(["worktree", "show", "--worktree", "active"]);
          if (focused.ok && focused.result.worktree?.id) selector = `id:${focused.result.worktree.id}`;
        }
        if (!selector) continue;
        const opened = await client.call<{ terminal?: { handle?: string } }>(["terminal", "create", "--worktree", selector, "--title", o.title, "--command", shellCommand([script])]);
        if (opened.ok && opened.result.terminal?.handle) return { opened: true, target, command };
      } else {
        let argv: string[];
        if (target === "tmux") {
          if (!d.env.TMUX || !d.which("tmux")) continue;
          argv = ["tmux", "new-window", shellCommand([script])];
        } else if (d.platform === "darwin") {
          if (!d.which("open")) continue;
          let app = "Terminal";
          try {
            const raw = Bun.YAML.parse(readFileSync(strategyPath(ctx), "utf8")) as { terminal?: { app?: string } };
            if (["Terminal", "iTerm", "Ghostty"].includes(raw?.terminal?.app ?? "")) app = raw.terminal!.app!;
          } catch { /* default before configuration */ }
          argv = ["open", "-a", app, script];
        } else if (d.platform === "linux" && d.which("x-terminal-emulator")) {
          argv = ["x-terminal-emulator", "-e", script];
        } else continue;
        const result = await d.run(argv, 5000, { env: d.env });
        if (result.code === 0) return { opened: true, target, command };
      }
    } catch { /* Try the next available terminal. */ }
  }
  return { opened: false, target: "none", command };
}
