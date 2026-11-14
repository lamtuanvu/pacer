/**
 * Core's private credentials arrive on its stdin, never in its environment (#918, ADR 0027).
 *
 * Any process running as the same user, sandboxed or not, can read another process's initial
 * environment (`sysctl(KERN_PROCARGS2)` on macOS, `/proc/<pid>/environ` on Linux). So the Rust
 * front doors (serve and the stdio door) write one frame as the first bytes on Core's stdin:
 *
 *   pacer-core-secrets/1 <length>\n<length bytes of JSON>
 *
 * The JSON holds any of `internalToken`, `ownerKey` and `nativeConfigSyncKey`, each 64 hex
 * digits (`crates/server/src/core_secrets.rs`), compact and with no repeated key.
 * `PACER_CORE_SECRETS=stdin/1` announces it. Core reads exactly the frame's bytes once, at
 * startup, so later stdin readers see only what follows; a missing or malformed frame refuses
 * the start, and so does a terminal or a stdin that stays silent for 10 seconds. A paired native
 * Core reads it from its parent channel after acknowledging the authenticated `B` descriptor
 * byte. The secret names are removed from the environment whether or not a frame comes, so
 * nothing Core spawns inherits them.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { readSync } from "node:fs";
import { isatty } from "node:tty";

export const OWNER_KEY_ENV = "PACER_HOST_SOCKET_KEY";
/** Names no Core environment keeps, and no child of Core receives. */
export const CORE_SECRET_ENV = [OWNER_KEY_ENV, "PACER_INTERNAL_TOKEN", "PACER_NATIVE_CONFIG_SYNC_KEY"] as const;
export const CORE_SECRETS_ENV = "PACER_CORE_SECRETS";
export const CORE_SECRETS_STDIN = "stdin/1";

const MAGIC = "pacer-core-secrets/1 ";
const FAMILY = "pacer-core-secrets/";
const HEADER = /^pacer-core-secrets\/1 ([1-9][0-9]{0,3})\n$/;
const MAX_HEADER = MAGIC.length + 5;
const MAX_BODY = 4096;
const HEX_KEY = /^[0-9a-f]{64}$/;
const FIELDS = ["internalToken", "ownerKey", "nativeConfigSyncKey"] as const;
const READ_TIMEOUT_MS = 10_000;
const POLLIN = 1;
const SAME_BUILD = "the pacer front door and pacer-core must come from the same build";

export type CoreSecrets = Partial<Record<(typeof FIELDS)[number], string>>;

export class CoreSecretsError extends Error {}

const missing = () => new CoreSecretsError(`Core expected its secrets on stdin (${CORE_SECRETS_ENV}=${CORE_SECRETS_STDIN}), but the frame is missing; refusing to start`);
const malformed = () => new CoreSecretsError(`Core's secrets frame on stdin is malformed; refusing to start`);

/** Remove the secret names and the announcement from `env` and the process environment.
 * True when the parent announced a frame. Call before anything spawns a child. */
export function scrubCoreSecrets(env: Record<string, string | undefined>): boolean {
  const announced = env[CORE_SECRETS_ENV];
  for (const name of [...CORE_SECRET_ENV, CORE_SECRETS_ENV]) {
    delete env[name];
    delete process.env[name];
  }
  if (announced === undefined) return false;
  if (announced !== CORE_SECRETS_STDIN) throw new CoreSecretsError(`Unsupported ${CORE_SECRETS_ENV} value (${SAME_BUILD}); refusing to start`);
  return true;
}

/** An older front door put Core's secrets in its environment and announced no frame. */
export function legacyCoreSecrets(env: Record<string, string | undefined>): boolean {
  return env[CORE_SECRETS_ENV] === undefined && CORE_SECRET_ENV.some(name => env[name] !== undefined);
}

export const LEGACY_CORE_SECRETS = `the front door passed Core's secrets in its environment, which this pacer-core ignores; ${SAME_BUILD}`;

let libc: ReturnType<typeof openLibrary> | undefined;
function openLibrary() {
  return dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    poll: { args: [FFIType.ptr, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
  });
}

/** Wait until `fd` is readable, at end of file or invalid. False once `deadline` passes. */
function readable(fd: number, deadline: number): boolean {
  const poll = (libc ??= openLibrary()).symbols.poll;
  const request = new Int32Array(2);
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    request[0] = fd;
    request[1] = POLLIN;
    // struct pollfd { int fd; short events; short revents; }; an interrupted poll retries.
    if (poll(ptr(request), 1, Math.min(remaining, 2 ** 31 - 1)) > 0) return true;
  }
}

/** Read the frame from `fd`, and not one byte more, within `timeoutMs` in all. */
export function readCoreSecrets(fd = 0, timeoutMs = READ_TIMEOUT_MS): CoreSecrets {
  // No front door writes the frame on a terminal.
  if (isatty(fd)) throw missing();
  const deadline = Date.now() + timeoutMs;
  let header = "";
  const read = (buffer: Buffer, offset: number, length: number): number => {
    for (;;) {
      if (!readable(fd, deadline)) throw header ? malformed() : missing();
      try {
        return readSync(fd, buffer, offset, length, null);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw missing();
      }
    }
  };
  const byte = Buffer.alloc(1);
  while (!header.endsWith("\n")) {
    if (!read(byte, 0, 1)) throw header ? malformed() : missing();
    header += String.fromCharCode(byte[0]!);
    // Stop at the first byte that cannot start the frame, such as a JSON-RPC line.
    if (!(header.length <= MAGIC.length ? MAGIC.startsWith(header) : header.startsWith(MAGIC)) || header.length > MAX_HEADER) {
      if (header.length > FAMILY.length && header.startsWith(FAMILY) && !header.startsWith(MAGIC))
        throw new CoreSecretsError(`Core's secrets frame on stdin has an unsupported version (${SAME_BUILD}); refusing to start`);
      throw malformed();
    }
  }
  const length = Number(HEADER.exec(header)?.[1] ?? NaN);
  if (!(length <= MAX_BODY)) throw malformed();
  const body = Buffer.alloc(length);
  for (let got = 0; got < length;) {
    const count = read(body, got, length - got);
    if (!count) throw malformed();
    got += count;
  }
  const text = body.toString("utf8");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw malformed(); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw malformed();
  // Only the compact encoding the front door writes: a repeated key or any other spelling differs.
  if (JSON.stringify(value) !== text) throw malformed();
  const secrets: CoreSecrets = {};
  for (const [name, secret] of Object.entries(value)) {
    if (!(FIELDS as readonly string[]).includes(name) || typeof secret !== "string" || !HEX_KEY.test(secret)) throw malformed();
    secrets[name as (typeof FIELDS)[number]] = secret;
  }
  return secrets;
}
