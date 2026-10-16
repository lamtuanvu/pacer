import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";

type RecordEntry = { hash: string; expiresAt: number };
type Store = "codes" | "sessions";
export const SESSION_SECONDS = 30 * 86400;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function read(ctx: Ctx, store: Store): RecordEntry[] {
  try {
    const records: unknown = JSON.parse(readFileSync(join(ctx.pacerHome, "app", `${store}.json`), "utf8"));
    if (!Array.isArray(records)) return [];
    return records.filter((r): r is RecordEntry => r && typeof r.hash === "string" && /^[a-f0-9]{64}$/.test(r.hash) && typeof r.expiresAt === "number" && r.expiresAt > ctx.now);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || e instanceof SyntaxError) return [];
    throw e;
  }
}

function write(ctx: Ctx, store: Store, records: RecordEntry[]): void {
  const dir = join(ctx.pacerHome, "app");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, `${store}.json`);
  const temp = join(dir, `.${store}.${randomBytes(12).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(records) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

function create(ctx: Ctx, store: Store, seconds: number): string {
  const value = randomBytes(32).toString("hex");
  write(ctx, store, [...read(ctx, store), { hash: hash(value), expiresAt: ctx.now + seconds }]);
  return value;
}

export const createCode = (ctx: Ctx): string => create(ctx, "codes", 60);
export const createSession = (ctx: Ctx): string => create(ctx, "sessions", SESSION_SECONDS);

export function redeemCode(ctx: Ctx, code: string): boolean {
  const records = read(ctx, "codes"), digest = hash(code);
  const found = records.findIndex(r => safeEqual(r.hash, digest));
  if (found < 0) return false;
  records.splice(found, 1);
  write(ctx, "codes", records);
  return true;
}

export function checkSession(ctx: Ctx, value: string): boolean {
  const records = read(ctx, "sessions"), digest = hash(value);
  const record = records.find(r => safeEqual(r.hash, digest));
  if (!record) return false;
  // Slide the expiry at most once a day so ordinary requests don't rewrite the file.
  if (record.expiresAt - ctx.now < SESSION_SECONDS - 86400) { record.expiresAt = ctx.now + SESSION_SECONDS; write(ctx, "sessions", records); }
  return true;
}

export function clearSessions(ctx: Ctx): void { write(ctx, "sessions", []); }
