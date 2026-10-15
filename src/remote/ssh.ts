import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HostCfg } from "../config/hosts";
import { shq } from "../install/fsx";
import type { Ctx, RunResult } from "../types";
import { SCRIPTS } from "./scripts";

/** Private directory for pacer's own OpenSSH multiplexing sockets. */
export function controlDir(ctx: Ctx): string {
  const dir = join(ctx.pacerHome, "ssh");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

export function sshArgv(ctx: Ctx, host: HostCfg, script: string, args: string[]): string[] {
  if (!Object.values<string>(SCRIPTS).includes(script)) throw new Error("unknown remote script");
  return [
    "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2",
    "-o", "ControlMaster=auto", "-o", `ControlPath=${join(controlDir(ctx), "cm-%C")}`,
    "-o", "ControlPersist=60", "--", host.ssh,
    `bash -lc ${shq(script)} pacer${args.map((arg) => ` ${shq(arg)}`).join("")}`,
  ];
}

export function runRemote(ctx: Ctx, host: HostCfg, script: string, args: string[], o: { stdin?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  return ctx.run(sshArgv(ctx, host, script, args), o.timeoutMs ?? 60_000, { stdin: o.stdin });
}
