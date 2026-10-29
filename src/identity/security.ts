import type { Ctx, RunResult } from "../types";

/**
 * Run the macOS `security` tool. Secrets go through stdin (`security -i`), never argv. A subprocess error is
 * replaced by `failure`, because it may contain argv or credentials.
 */
export async function security(ctx: Pick<Ctx, "run">, args: string[], failure: string, stdin?: string): Promise<RunResult> {
  try { return await ctx.run(["security", ...args], 10000, stdin === undefined ? undefined : { stdin }); }
  catch { throw new Error(failure); }
}

const FAILED = "machine identity keychain operation failed";

/** The value of a generic password as `security -w` prints it (hex when it is not printable), or null when missing (exit 44). */
export async function findPassword(ctx: Pick<Ctx, "run">, service: string, account: string): Promise<string | null> {
  const r = await security(ctx, ["find-generic-password", "-s", service, "-a", account, "-w"], FAILED);
  if (r.code === 44) return null;
  if (r.code !== 0) throw new Error("machine identity keychain read failed");
  return r.stdout.replace(/\r?\n$/, "");
}

/**
 * Add or update a generic password and confirm it by reading it back: `security -i` can exit 0 after a failed
 * command, and an update can fail while the old item still exists. `matches` compares the printed value.
 */
export async function writePassword(ctx: Pick<Ctx, "run">, service: string, account: string, value: Uint8Array, matches: (printed: string) => boolean): Promise<void> {
  const r = await security(ctx, ["-i"], FAILED, `add-generic-password -U -s ${service} -a ${account} -X ${Buffer.from(value).toString("hex")}\n`);
  if (r.code !== 0) throw new Error("machine identity keychain write failed");
  let back: string | null;
  try { back = await findPassword(ctx, service, account); } catch { throw new Error("machine identity keychain write failed"); }
  if (back === null || !matches(back)) throw new Error("machine identity keychain write failed");
}

export async function deletePassword(ctx: Pick<Ctx, "run">, service: string, account: string): Promise<void> {
  const r = await security(ctx, ["delete-generic-password", "-s", service, "-a", account], FAILED);
  if (r.code !== 0 && r.code !== 44) throw new Error("machine identity keychain delete failed");
}
