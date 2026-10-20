import { existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { PLUGIN_FILES, PANEL_PLACEHOLDER, PLUGIN_VERSION } from "../../src/plugin/assets.generated";
import { atomicWrite, checkout, launch, record, run, sandboxEnv, saveSession, shellQuote, type Session } from "./core";
import { mkdirSync } from "node:fs";

export async function tui(session: Session, action: string, keys: string[], out?: string): Promise<string> {
  if (!Bun.which("tmux")) throw Error("tmux is required for the TUI; record this surface as UNVERIFIED if unavailable");
  const target = `pacer-live-${session.id}`;
  let args: string[];
  switch (action) {
    case "start": {
      // tmux's server may predate this sandbox: pass the environment explicitly.
      const env = sandboxEnv(session);
      const assignments = ["HOME", "PATH", "PACER_BIN", "PACER_HOME", "PACER_PORT", "PACER_BACKEND", "PACER_NO_UPDATE_CHECK", "PACER_ORCA_USER_DATA", "PACER_ROLE"].filter(key => env[key] !== undefined)
        .map(key => `${key}=${env[key]!}`);
      const command = ["/usr/bin/env", ...assignments, env.PACER_BIN!, "dashboard"].map(shellQuote).join(" ");
      args = ["new-session", "-d", "-x", "120", "-y", "40", "-s", target, "-c", join(session.root, "repo"), command];
      break;
    }
    case "keys":
      if (!keys.length) throw Error("tui keys requires at least one tmux key, e.g. Down or Enter");
      args = ["send-keys", "-t", target, "--", ...keys];
      break;
    case "capture": args = ["capture-pane", "-p", "-t", target]; break;
    case "stop": args = ["kill-session", "-t", target]; break;
    default: throw Error("usage: live tui start|keys <keys...>|capture [--out <name>]|stop");
  }
  const result = await run(["tmux", ...args], session);
  if (result.code) throw Error(`tmux: ${result.stderr}`);
  if (action === "capture") {
    const path = join(session.root, "evidence", out ? basename(out) : `tui-${Date.now()}.txt`);
    atomicWrite(path, result.stdout);
    record(session, { kind: "capture", path, text: "TUI capture" });
    return path;
  }
  return result.stdout;
}

export function desktopExecutable(app: string): string {
  if (app.endsWith(".app")) {
    const binaries = join(app, "Contents/MacOS");
    const names = readdirSync(binaries).filter(name => lstatSync(join(binaries, name)).isFile());
    const info = join(app, "Contents/Info.plist");
    const result = existsSync(info) && process.platform === "darwin"
      ? Bun.spawnSync(["/usr/bin/plutil", "-extract", "CFBundleExecutable", "raw", "-o", "-", info])
      : undefined;
    if (result && result.exitCode !== 0) {
      throw Error(`plutil failed reading desktop CFBundleExecutable: ${result.stderr.toString().trim() || result.stdout.toString().trim()}`);
    }
    const name = result?.stdout.toString().trim();
    if (name) {
      if (basename(name) !== name || !names.includes(name)) throw Error("Invalid CFBundleExecutable in desktop bundle");
      app = join(binaries, name);
    } else {
      if (names.length !== 1) throw Error("Pass the desktop executable with --app (bundle has multiple executables)");
      app = join(binaries, names[0]);
    }
  }
  if (!existsSync(app)) throw Error(`Desktop executable does not exist: ${app}`);
  return app;
}

export function desktop(session: Session, requested?: string): string {
  if (process.platform !== "darwin") throw Error("Desktop launch requires macOS; record desktop as UNVERIFIED");
  let app = requested ? resolve(requested) : undefined;
  if (!app) {
    const bundles = join(checkout, "desktop/src-tauri/target/release/bundle/macos");
    app = existsSync(bundles) ? readdirSync(bundles).filter(name => name.endsWith(".app")).map(name => join(bundles, name))[0] : undefined;
  }
  if (!app) throw Error("No built desktop app; build it or pass --app <path>, otherwise record UNVERIFIED");
  app = desktopExecutable(app);
  // Desktop asks a login shell for PATH. Keep that lookup inside the guard even
  // when the real user's login startup files replace PATH.
  const shell = join(session.root, "bin/login-shell");
  atomicWrite(shell, '#!/bin/sh\nif [ "$1" = -l ]; then shift; fi\nexec /bin/sh "$@"\n', 0o700);
  session.desktopPid = launch(session, [app], "desktop.log", { SHELL: shell });
  saveSession(session);
  record(session, { kind: "command", argv: [app], code: 0, stdout: `Launched PID ${session.desktopPid}; inspect with computer-use` });
  return `Desktop launched (PID ${session.desktopPid}); use computer-use to inspect it.`;
}

export async function orca(session: Session, print: boolean): Promise<string> {
  // Write only sandbox-owned plugin assets. The managed marker lets serve refresh live.html.
  const plugin = join(session.root, "home/orca-plugin");
  mkdirSync(plugin, { recursive: true, mode: 0o700 });
  for (const file of PLUGIN_FILES) {
    const path = join(plugin, file.rel);
    mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
    if (file.rel === "worker.mjs") {
      atomicWrite(join(plugin, "worker-source.mjs"), file.text);
      atomicWrite(path, isolatedWorker(session));
    } else atomicWrite(path, file.text);
  }
  atomicWrite(join(plugin, ".pacer-managed"), JSON.stringify({ version: PLUGIN_VERSION, installedAt: new Date().toISOString() }));
  const panel = join(plugin, "panel/live.html");
  mkdirSync(join(plugin, "panel"), { recursive: true, mode: 0o700 });
  if (!existsSync(panel)) atomicWrite(panel, PANEL_PLACEHOLDER);
  // serve refreshes the actual live panel every two seconds; don't claim a fixture is live.
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline && readFileSync(panel, "utf8") === PANEL_PLACEHOLDER) await Bun.sleep(100);
  if (readFileSync(panel, "utf8") === PANEL_PLACEHOLDER) throw Error("Service did not render the sandbox's live Orca panel; inspect logs/serve.log");
  if (print) {
    const path = join(session.root, "evidence/orca-panel.html");
    atomicWrite(path, readFileSync(panel, "utf8"));
    record(session, { kind: "capture", path, text: "Live Orca panel HTML; host integration remains UNVERIFIED" });
    return `${path}\nInspect this file with browser MCP. Orca host integration is UNVERIFIED.`;
  }
  // Electron's flag is required as well as PACER_ORCA_USER_DATA (which only redirects pacer's files).
  // Never call a running Orca CLI, which could resolve to the user's real profile.
  const binary = process.env.PACER_LIVE_ORCA_BINARY;
  if (!binary || !existsSync(binary)) throw Error("Set PACER_LIVE_ORCA_BINARY to the Orca Electron executable for an isolated instance, or use live orca --print; never use the real profile");
  session.orcaPid = launch(session, [resolve(binary), `--user-data-dir=${sandboxEnv(session).PACER_ORCA_USER_DATA!}`], "orca.log");
  saveSession(session);
  record(session, { kind: "note", text: `Isolated Orca launched (PID ${session.orcaPid}); profile ${sandboxEnv(session).PACER_ORCA_USER_DATA}` });
  return `Isolated Orca launched (PID ${session.orcaPid}). In THIS instance's Settings > Plugins, enable plugins and add development folder ${plugin}, then enable pacer and open its panel. If isolation cannot be confirmed, stop it and use orca --print. Inspect logs/orca.log for startup failures.`;
}

/** Host settings otherwise default to the real ~/.pacer and port 4317. */
export function isolatedWorker(session: Session): string {
  // Orca scrubs the worker process environment. Restore isolation before the
  // source module captures paths for subprocesses, heartbeats and update checks.
  const env = sandboxEnv(session);
  const keys = ["PACER_BIN", "PACER_HOME", "PACER_PORT", "PACER_BACKEND", "PACER_NO_UPDATE_CHECK", "PACER_ORCA_USER_DATA",
    ...(session.seed === "ui" ? ["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME"] : [])];
  const overrides = Object.fromEntries(keys.map(key => [key, env[key]]));
  const guardPath = session.seed === "ui" ? `${join(session.root, "home/bin")}:${join(session.root, "bin")}` : join(session.root, "bin");
  return `Object.assign(process.env, ${JSON.stringify(overrides)});
process.env.PATH = ${JSON.stringify(guardPath)} + ":" + (process.env.PATH ?? "");
const { default: activate, deactivate } = await import("./worker-source.mjs");
export { deactivate };
export default function(ctx) {
  const host = ctx.host;
  return activate({ ...ctx, host: { ...host, async call(method, params) {
    const reply = await host.call(method, params);
    if (method !== "settings.get") return reply;
    return { ...reply, settings: { ...reply.settings, port: ${session.port}, pacerHome: ${JSON.stringify(join(session.root, "home"))} } };
  } } });
}
`;
}
