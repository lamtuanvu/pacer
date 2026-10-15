import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { KeySource } from "../config/accounts";
import type { Ctx, RunResult } from "../types";

function validate(name: string, source: KeySource): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw Error("invalid endpoint name");
  if (!/^(keychain|file|none|env:[A-Za-z_][A-Za-z0-9_]*)$/.test(source)) throw Error("invalid endpoint key source");
}
async function security(ctx: Ctx, args: string[], stdin?: string): Promise<RunResult> {
  // Never propagate a subprocess error: it may contain credentials or argv.
  try { return await ctx.run(["security", ...args], 10000, stdin === undefined ? undefined : { stdin }); }
  catch { throw Error("endpoint keychain operation failed"); }
}
function check(result: RunResult): void {
  if (result.code !== 0) throw Error("endpoint keychain operation failed");
}
export async function writeKey(ctx: Ctx, name: string, source: KeySource, key: string): Promise<void> {
  validate(name, source);
  if (source === "none") return;
  if (source.startsWith("env:")) throw Error("environment keys must be managed in the environment");
  if (!key) throw Error("endpoint key must not be empty");
  if (source === "keychain") {
    // Keep even reversible hex data out of argv by feeding the command to stdin.
    const stdin = `add-generic-password -U -s pacer -a endpoint/${name} -X ${Buffer.from(key).toString("hex")}\n`;
    check(await security(ctx, ["-i"], stdin));
    // Interactive mode can exit successfully after a failed command. Confirm
    // the item exists without requesting its secret.
    check(await security(ctx, ["find-generic-password", "-s", "pacer", "-a", `endpoint/${name}`]));
    return;
  }
  const dir = join(ctx.pacerHome, "secrets"), path = join(dir, `${name}.key`), temp = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dir, {recursive: true, mode: 0o700}); chmodSync(dir, 0o700);
    writeFileSync(temp, key, {flag: "wx", mode: 0o600});
    renameSync(temp, path);
  } catch { throw Error("endpoint key file write failed"); }
  finally { rmSync(temp, {force: true}); }
}
export async function readKey(ctx: Ctx, name: string, source: KeySource): Promise<string | null> {
  validate(name, source);
  if (source === "none") return null;
  if (source.startsWith("env:")) return ctx.env[source.slice(4)] || null;
  if (source === "keychain") {
    const result = await security(ctx, ["find-generic-password", "-s", "pacer", "-a", `endpoint/${name}`, "-w"]);
    if (result.code === 44) return null;
    check(result);
    return result.stdout.replace(/\r?\n$/, "") || null;
  }
  try { return readFileSync(join(ctx.pacerHome, "secrets", `${name}.key`), "utf8") || null; }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw Error("endpoint key file read failed");
  }
}
export async function hasKey(ctx: Ctx, name: string, source: KeySource): Promise<boolean> {
  validate(name, source);
  return source === "none" || (await readKey(ctx, name, source)) !== null;
}
export async function deleteKey(ctx: Ctx, name: string, source: KeySource): Promise<void> {
  validate(name, source);
  if (source === "none" || source.startsWith("env:")) return;
  if (source === "keychain") {
    const result = await security(ctx, ["delete-generic-password", "-s", "pacer", "-a", `endpoint/${name}`]);
    if (result.code !== 44) check(result);
    return;
  }
  try { rmSync(join(ctx.pacerHome, "secrets", `${name}.key`), {force: true}); }
  catch { throw Error("endpoint key file deletion failed"); }
}
