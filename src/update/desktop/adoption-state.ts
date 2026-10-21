/** Candidate-free adoption state. All writers hold the home coordinator transaction. */
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { CoreError } from "../../core/errors";
import type { Installation } from "./types";
import { isVersion } from "../version";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  path = z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (p) =>
        p.startsWith("/") &&
        !p.includes("\0") &&
        !p.split("/").some((p) => p === "." || p === ".."),
    );
const target = z
  .object({
    id,
    appPath: path,
    bundleId: z.literal("dev.pacer.desktop"),
    ownerUid: integer,
    arch: z.enum(["aarch64", "x86_64"]),
    pacerHome: path,
    port: z.number().int().min(1).max(65535),
    serviceLabel: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
    ownership: z.literal("attached"),
    version: z.string().refine(isVersion),
  })
  .strict();
const processIdentity = z
  .object({
    pid: z.number().int().positive(),
    bootId: z.string().min(1),
    birth: z.string().min(1),
  })
  .strict();
export const adoptionAuthoritySchema = z
  .object({
    target,
    nativeSessionId: id,
    desktopClientId: id,
    bootId: z.string().min(1),
    desktop: processIdentity,
    service: processIdentity,
    serviceVersion: z.string().refine(isVersion),
    oldServiceExecutable: path,
    newServiceExecutable: path,
  })
  .strict()
  .refine(
    (v) =>
      v.bootId === v.desktop.bootId &&
      v.bootId === v.service.bootId &&
      v.oldServiceExecutable !== v.newServiceExecutable &&
      v.newServiceExecutable === v.target.appPath + "/Contents/Resources/pacer",
  );
export const adoptionPhases = [
  "waiting",
  "reserved",
  "installing",
  "verifying",
  "committed",
  "restored",
  "recovery-failed",
  "cancelled",
] as const;
export type AdoptionPhase = (typeof adoptionPhases)[number];
export const adoptionSchema = z
  .object({
    schema: z.literal(1),
    installationId: id,
    revision: integer,
    transactionId: id,
    phase: z.enum(adoptionPhases),
    authority: adoptionAuthoritySchema,
    resultingInstallationId: id.nullable(),
    blockers: z.array(
      z.object({
        kind: z.enum(["task", "session", "launch", "operation"]),
        id: z.string(),
        label: z.string(),
      }),
    ),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
    receipts: z
      .array(
        z.object({
          requestId: id,
          action: z.enum(["adopt", "adoptCancel"]),
          fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          transactionId: id,
          expectRevision: integer,
        }),
      )
      .min(1)
      .max(1024),
  })
  .strict()
  .refine(
    (v) =>
      v.installationId === v.authority.target.id &&
      new Set(v.receipts.map((r) => r.requestId)).size === v.receipts.length &&
      (v.phase !== "committed" || !!v.resultingInstallationId),
  );
export type AdoptionRecord = z.infer<typeof adoptionSchema>;
export type AdoptionAuthority = Omit<
  z.input<typeof adoptionAuthoritySchema>,
  "target"
> & { target: Installation };
export const adoptionPending = (record: AdoptionRecord) =>
  !["committed", "restored", "cancelled"].includes(record.phase);
export const adoptionConflict = () =>
  new CoreError(
    "conflict",
    "Desktop service adoption changed",
    "Read the current adoption status and retry with a new request ID.",
  );
export function adoptionRows(db: Database): AdoptionRecord[] {
  const table = db
    .query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='desktop_adoptions'",
    )
    .get();
  if (!table) return [];
  const rows = db
    .query<
      { body: string },
      []
    >("SELECT body FROM desktop_adoptions LIMIT 1025")
    .all();
  if (rows.length > 1024) throw adoptionConflict();
  return rows.map((row) => {
    if (row.body.length > 1048576) throw adoptionConflict();
    return adoptionSchema.parse(JSON.parse(row.body));
  });
}
export function assertNoPendingAdoption(db: Database): void {
  if (adoptionRows(db).some(adoptionPending))
    throw new CoreError(
      "conflict",
      "Desktop service adoption is pending",
      "Cancel the waiting adoption or retain its recovery state.",
    );
}
export function saveAdoption(
  db: Database,
  value: AdoptionRecord,
): AdoptionRecord {
  const parsed = adoptionSchema.parse(value);
  const body = JSON.stringify(parsed);
  if (body.length > 1048576) throw adoptionConflict();
  db.exec(
    "CREATE TABLE IF NOT EXISTS desktop_adoptions (installation_id TEXT PRIMARY KEY, body TEXT NOT NULL, history TEXT NOT NULL)",
  );
  const old = db
    .query<
      { body: string; history: string },
      [string]
    >("SELECT body,history FROM desktop_adoptions WHERE installation_id=?")
    .get(parsed.installationId);
  let history: AdoptionRecord[] = [];
  if (old) {
    history = parseHistory(old.history);
    const previous = adoptionSchema.parse(JSON.parse(old.body));
    if (previous.transactionId !== parsed.transactionId) {
      if (adoptionPending(previous)) throw adoptionConflict();
      history.push(previous);
    }
  }
  const savedHistory = JSON.stringify(history);
  if (history.length > 1024 || savedHistory.length > 1048576)
    throw adoptionConflict();
  db.query(
    "INSERT INTO desktop_adoptions (installation_id,body,history) VALUES (?,?,?) ON CONFLICT(installation_id) DO UPDATE SET body=excluded.body,history=excluded.history",
  ).run(parsed.installationId, body, savedHistory);
  return parsed;
}

function parseHistory(text: string): AdoptionRecord[] {
  if (text.length > 1048576) throw adoptionConflict();
  const values = z.array(adoptionSchema).max(1024).parse(JSON.parse(text));
  if (values.some(adoptionPending)) throw adoptionConflict();
  return values;
}
export function adoptionReplay(
  db: Database,
  current: AdoptionRecord,
  transactionId: string,
): AdoptionRecord {
  if (current.transactionId === transactionId) return current;
  const row = db
    .query<
      { history: string },
      [string]
    >("SELECT history FROM desktop_adoptions WHERE installation_id=?")
    .get(current.installationId);
  const result =
    row &&
    parseHistory(row.history).find(
      (value) => value.transactionId === transactionId,
    );
  if (!result) throw adoptionConflict();
  return result;
}
