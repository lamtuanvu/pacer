import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";

/**
 * Where serve's native plugin owner binds `host.sock`, mirroring the Rust
 * `connection_dir::serve_socket_dir(pacer_home, uid, create=false)` (ADR 0027
 * item 5, B0b): `run/` when `run/host.sock` fits in `sockaddr_un` (103 bytes
 * on macOS), else the private per-user directory `<user dir>/pacer-<hash>/`
 * where `<user dir>` is the OS per-user private directory and `<hash>` is the
 * 64-bit FNV-1a of the canonical home. The serve-side fixtures use this so
 * their assertions follow the bound socket instead of assuming `run/`.
 */
export const SOCKET_PATH_MAX = process.platform === "darwin" ? 103 : 107;
export const HOST_SOCKET_NAME = "host.sock";

export function pacerHash(pacerHome: string): string {
  const canonical = realpathSync(pacerHome);
  let hash = 0xcbf2_9ce4_8422_2325n;
  for (const byte of Buffer.from(canonical, "utf8")) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x0100_0000_01b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

/** The OS per-user private directory (confstr DARWIN_USER_TEMP_DIR / $XDG_RUNTIME_DIR). */
export function userPrivateDir(): string {
  if (process.platform === "darwin") {
    return execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim().replace(/\/+$/, "");
  }
  const dir = process.env.XDG_RUNTIME_DIR;
  if (!dir || !dir.startsWith("/")) throw Error("XDG_RUNTIME_DIR is not set");
  return dir.replace(/\/+$/, "");
}

/** True when `run/host.sock` would exceed the socket path limit, forcing the private per-user dir. */
export function deepServeHome(pacerHome: string): boolean {
  return join(pacerHome, "run", HOST_SOCKET_NAME).length > SOCKET_PATH_MAX;
}

/** The directory serve actually binds `host.sock` in, without creating anything. */
export function serveSocketDir(pacerHome: string): string {
  if (!deepServeHome(pacerHome)) return join(pacerHome, "run");
  return join(userPrivateDir(), `pacer-${pacerHash(pacerHome)}`);
}

/** The expected full `host.sock` path serve binds for `pacerHome`. */
export function serveSocketPath(pacerHome: string): string {
  return join(serveSocketDir(pacerHome), HOST_SOCKET_NAME);
}