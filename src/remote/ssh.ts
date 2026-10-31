import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HostCfg } from "../config/hosts";
import { shq } from "../install/fsx";
import type { Ctx } from "../types";
import { SCRIPTS } from "./scripts";

/** Private directory for pacer's own OpenSSH multiplexing sockets. */
export function controlDir(ctx: Ctx): string {
  const homeDir = join(ctx.pacerHome, "ssh");
  // OpenSSH expands %C to 40 hex bytes; macOS rejects socket paths >= 104 bytes.
  const tooLong = Buffer.byteLength(join(homeDir, `cm-${"f".repeat(40)}`)) >= 104;
  const short = tooLong && process.platform !== "win32";
  const dir = short
    ? join("/tmp", `pacer-ssh-${process.getuid!()}-${createHash("sha256").update(ctx.pacerHome).digest("hex").slice(0, 16)}`)
    : homeDir;
  if (short) {
    try { mkdirSync(dir, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const entry = lstatSync(dir);
    if (!entry.isDirectory() || entry.uid !== process.getuid!() || (entry.mode & 0o077) !== 0) {
      throw new Error("SSH control directory is not private and owned by this user");
    }
  } else {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  return dir;
}

/** The exact argv the host pins for the bundled pacer-ssh plugin; core never spawns it itself. */
export function sshArgv(ctx: Ctx, host: HostCfg, script: string, args: string[], completionNonce?: string): string[] {
  if (!Object.values<string>(SCRIPTS).includes(script)) throw new Error("unknown remote script");
  if (completionNonce && !/^[a-f0-9-]{36}$/.test(completionNonce)) throw new Error("invalid remote completion nonce");
  const program = completionNonce
    ? `printf '__PACER_BEGIN__\\n'; ( ${script}\n); pacer_result=$?; printf '\\n__PACER_DONE__=${completionNonce}\\n'; exit "$pacer_result"`
    : `printf '__PACER_BEGIN__\\n'; ${script}`;
  return [
    "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2",
    "-o", "ControlMaster=auto", "-o", `ControlPath=${join(controlDir(ctx), "cm-%C")}`,
    "-o", "ControlPersist=60", "--", host.ssh,
    `bash -lc ${shq(program)} pacer${args.map((arg) => ` ${shq(arg)}`).join("")}`,
  ];
}
