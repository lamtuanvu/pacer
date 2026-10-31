import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";

export interface ShellDeps {
  platform: string;
  username: string;
  uid: number;
  lookup: (argv: string[]) => string;
  read: () => string;
  executable: (path: string) => boolean;
}

/** The OS account is authoritative even when launchd supplies a minimal or different SHELL. */
export function resolveLoginShell(env: Record<string, string | undefined>, overrides: Partial<ShellDeps> = {}): string {
  const account = userInfo();
  const deps: ShellDeps = {
    platform: process.platform, username: account.username, uid: account.uid,
    lookup: argv => execFileSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: 2000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "ignore"] }),
    read: () => readFileSync("/etc/shells", "utf8"),
    executable: path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } },
    ...overrides,
  };
  let shell: string | undefined;
  try {
    if (deps.platform === "darwin") {
      shell = deps.lookup(["/usr/bin/dscl", ".", "-read", `/Users/${deps.username}`, "UserShell"]).match(/^UserShell:\s*(\S+)\s*$/m)?.[1];
    } else if (deps.platform === "linux") {
      shell = deps.lookup(["getent", "passwd", String(deps.uid)]).trim().split("\n")[0]?.split(":")[6];
    }
  } catch { /* Account databases can be unavailable; validate the environment fallback below. */ }
  let listed: string[] = [];
  try { listed = deps.read().split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#")); } catch { /* Executable paths remain valid without /etc/shells. */ }
  for (const candidate of [shell, env.SHELL, "/bin/sh"]) {
    if (candidate && isAbsolute(candidate) && !/[\0\r\n]/.test(candidate) && (listed.includes(candidate) || deps.executable(candidate))) return candidate;
  }
  return "/bin/sh";
}
