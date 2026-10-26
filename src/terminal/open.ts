import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { strategyPath } from "../config/strategy";
import { CoreError } from "../core/errors";
import { detectTerminal, splitArgv } from "../session/targets";
import { OrcaClient, isReady } from "../exec/orca/client";
import { shellCommand } from "../install/fsx";
import { createTerminal } from "./workspace";
import type { Ctx, RunFn } from "../types";
import { attachRunEvidenceSync, beginWorkSync, finishUnlaunchedWorkSync, markLaunchStartedSync, withWork } from "../update/desktop/admission";

export interface TerminalDeps {
  platform: NodeJS.Platform;
  which: Ctx["which"];
  run: RunFn;
  orcaAvailable(): Promise<boolean>;
  env: Ctx["env"];
}
type Target = "orca" | "terminal" | "tmux" | "builtin";
export interface TerminalOptions {
  argv: string[];
  env?: Record<string, string>;
  title: string;
  target?: "auto" | Target;
  worktree?: string;
  requestId?: string;
}
/** Open only pacer-built argv; return the same copyable command on headless hosts. */
export async function openInTerminal(ctx: Ctx, o: TerminalOptions, deps: Partial<TerminalDeps> = {}): Promise<{ opened: boolean; target: Target | "none"; command: string; terminalId?: string }> {
  if (!o.argv.length) throw new CoreError("invalid_input", "terminal command is empty");
  if (o.target === "builtin") {
    const terminal = await createTerminal(ctx, {kind:"action",requestId:o.requestId ?? randomUUID(),title:o.title,cwd:ctx.home,argv:o.argv,env:o.env});
    return {opened:true,target:"builtin",command:shellCommand(o.argv),terminalId:terminal.id};
  }
  return withWork(ctx, { kind: "operation", id: randomUUID(), label: "Opening terminal" }, () => openAdmitted(ctx, o, deps));
}

async function openAdmitted(ctx: Ctx, o: TerminalOptions, deps: Partial<TerminalDeps>): Promise<{ opened: boolean; target: Target | "none"; command: string }> {
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
  // Each external attempt gets its own completion identity. A failed launcher
  // may already have started its command; a later fallback must not release it.
  const launchScript = () => {
    const lease = beginWorkSync(ctx, { kind: "session", id: randomUUID(), label: o.title });
    try {
      const receiptDir = join(ctx.pacerHome, "desktop-updates", `terminal-${lease}`);
      mkdirSync(receiptDir, { mode: 0o700 });
      attachRunEvidenceSync(ctx, lease, receiptDir);
      const script = join(dir, `${randomUUID()}.sh`);
      const contents = [
        "#!/bin/sh", "umask 077",
        "unset PACER_ADMISSION_LEASE PACER_ADMISSION_TASK PACER_ADMISSION_SESSION PACER_ADMISSION_DIR PACER_COMPLETION_NONCE",
        "unset pacer_receipt_dir pacer_receipt_nonce",
        `pacer_receipt_dir=${shellCommand([receiptDir])}`,
        `pacer_receipt_nonce=${shellCommand([lease])}`,
        'if ! /bin/mkdir "$pacer_receipt_dir/claimed"; then exit 125; fi',
        command, "pacer_exit=$?",
        'printf \'%s\\n\' "$pacer_exit" > "$pacer_receipt_dir/exit.tmp" && /bin/mv "$pacer_receipt_dir/exit.tmp" "$pacer_receipt_dir/exit"',
        'printf \'%s\\n\' "$pacer_receipt_nonce" > "$pacer_receipt_dir/admission.complete.tmp" && /bin/mv "$pacer_receipt_dir/admission.complete.tmp" "$pacer_receipt_dir/admission.complete"',
        'exit "$pacer_exit"', "",
      ].join("\n");
      writeFileSync(script, contents, { mode: 0o700, flag: "wx" });
      chmodSync(script, 0o700);
      const cleanup = setTimeout(() => { try { rmSync(script, { force: true }); } catch { /* removed on next open */ } }, 3600000);
      cleanup.unref();
      markLaunchStartedSync(ctx, lease);
      return script;
    } catch (error) {
      finishUnlaunchedWorkSync(ctx, lease);
      throw error;
    }
  };
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
        const script = launchScript();
        const opened = await client.call<{ terminal?: { handle?: string } }>(["terminal", "create", "--worktree", selector, "--title", o.title, "--command", shellCommand([script])]);
        if (opened.ok && opened.result.terminal?.handle) return { opened: true, target, command };
      } else {
        let argv: string[];
        if (target === "tmux") {
          if (!d.env.TMUX || !d.which("tmux")) continue;
          argv = ["tmux", "new-window", shellCommand([launchScript()])];
        } else if (d.platform === "darwin") {
          if (!d.which("open")) continue;
          const names: Record<string, string> = {
            "terminal-app": "Terminal", iterm: "iTerm", ghostty: "Ghostty",
            wezterm: "WezTerm", kitty: "kitty", alacritty: "Alacritty",
          };
          let app = names[detectTerminal(ctx, d.platform) ?? ""] ?? "Terminal";
          let template: string | undefined;
          try {
            const raw = Bun.YAML.parse(readFileSync(strategyPath(ctx), "utf8")) as { terminal?: { app?: string; open?: string } };
            if (["Terminal", "iTerm", "Ghostty"].includes(raw?.terminal?.app ?? "")) app = raw.terminal!.app!;
            const selected = raw?.terminal?.open === "auto"
              ? detectTerminal(ctx, d.platform)
              : raw?.terminal?.open;
            if (selected && names[selected]) app = names[selected];
            else if (selected?.includes("{cmd}")) template = selected;
          } catch { /* default before configuration */ }
          const script = launchScript();
          argv = template
            ? splitArgv(template).map(arg => arg.replaceAll("{cmd}", script))
            : ["open", "-a", app, script];
        } else if (d.platform === "linux") {
          let selected: string | undefined;
          try {
            const raw = Bun.YAML.parse(readFileSync(strategyPath(ctx), "utf8")) as {terminal?: {open?: string}};
            selected = raw?.terminal?.open;
          } catch { /* default before configuration */ }
          if (selected === "auto") selected = detectTerminal(ctx, d.platform) ?? undefined;
          if (!selected && !d.which("x-terminal-emulator")) continue;
          const script = launchScript();
          const linux: Record<string, string[]> = {
            ghostty: ["ghostty", "-e", script],
            wezterm: ["wezterm", "start", "--", script],
            kitty: ["kitty", script],
            alacritty: ["alacritty", "-e", script],
            "gnome-terminal": ["gnome-terminal", "--", script],
            "x-terminal-emulator": ["x-terminal-emulator", "-e", script],
          };
          argv = selected?.includes("{cmd}")
            ? splitArgv(selected).map(arg => arg.replaceAll("{cmd}", script))
            : linux[selected ?? "x-terminal-emulator"] ?? ["x-terminal-emulator", "-e", script];
        } else continue;
        const result = await d.run(argv, 5000, { env: d.env });
        if (result.code === 0) return { opened: true, target, command };
      }
    } catch { /* Try the next available terminal. */ }
  }
  return { opened: false, target: "none", command };
}
