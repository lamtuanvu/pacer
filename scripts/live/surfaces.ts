import { existsSync, readdirSync, lstatSync } from "node:fs";
import { processIdentitySync } from "./control/lease";
import { basename, join, resolve } from "node:path";
import { atomicWrite, checkout, launch, record, run, sandboxEnv, saveSession, shellQuote, type Session } from "./core";

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
  session.desktopExecutable = app;
  session.desktopPid = launch(session, [app], "desktop.log", { SHELL: shell });
  const identity = processIdentitySync(session.desktopPid);
  if (identity) session.desktopIdentity = identity;
  saveSession(session);
  record(session, { kind: "command", argv: [app], code: 0, stdout: `Launched PID ${session.desktopPid}; inspect with computer-use` });
  return `Desktop launched (PID ${session.desktopPid}); use computer-use to inspect it.`;
}
