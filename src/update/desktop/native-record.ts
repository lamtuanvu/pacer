import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { CoreError } from "../../core/errors";
import type { Ctx } from "../../types";
import { assertIdentifier, requestFingerprint } from "./types";
import { readUpdate } from "./store";
import { parseAdapterCommand, parseInstallAuthorization } from "./adapter";

export const nativeProcessSchema = z
  .object({
    pid: z.number().int().positive(),
    bootId: z.string().min(1),
    birth: z.string().min(1),
  })
  .strict();
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
export const launchTicketSchema = z
  .object({
    schema: z.literal(1),
    installationId: id,
    transactionId: id,
    launchId: hash,
    nativeSessionId: id,
    nonce: hash,
    service: nativeProcessSchema,
    serviceVersion: z.string(),
    desktopVersion: z.string(),
    protocol: z.literal(3),
  })
  .strict()
  .refine((t) => t.nonce === t.launchId);
export type LaunchTicket = z.infer<typeof launchTicketSchema>;
export const readinessProofSchema = z
  .object({
    installationId: id,
    transactionId: id,
    desktop: nativeProcessSchema,
    nativeSessionId: id,
    desktopVersion: z.string(),
    service: nativeProcessSchema,
    serviceVersion: z.string(),
    protocol: z.literal(3),
    desktopSignedIn: z.literal(true),
    validStateRead: z.literal(true),
  })
  .strict();
export type NativeReadinessProof = z.infer<typeof readinessProofSchema>;
const manifestSchema = z
  .object({
    schema: z.literal(1),
    binding: z.unknown(),
    target: z.unknown(),
    candidate: z.unknown(),
    nativeSessionId: id,
    requesterBootId: z.string().min(1),
    oldDesktop: nativeProcessSchema,
    oldService: nativeProcessSchema,
    oldServiceExecutable: z
      .string()
      .min(1)
      .refine(
        (p) =>
          p.startsWith("/") &&
          !p.includes("\0") &&
          !p.split("/").some((part) => part === "." || part === ".."),
      ),
    oldServiceVersion: z.string().min(1),
    oldServiceProtocol: z.literal(3),
    oldAdmissionProtocol: z.literal(1),
    oldStateCompatible: z.literal(true),
  })
  .passthrough();
const launchEvidence = z
  .object({
    kind: z.literal("launched"),
    launch: z
      .object({
        role: z.enum(["desktop", "service"]),
        release: z.enum(["old", "candidate"]),
        launchId: hash,
        process: nativeProcessSchema,
        nativeSessionId: id,
        version: z.string(),
      })
      .strict(),
  })
  .strict();
const stepSchema = z.object({
  action: z.record(z.string(), z.unknown()),
  intentRevision: z.number().int().nonnegative(),
  intentBootId: z.string(),
  evidence: z.unknown().nullable(),
});
const journalSchema = z.object({
  schema: z.literal(1),
  revision: z.number().int().nonnegative(),
  manifestSha256: hash,
  state: z.enum([
    "preparing",
    "prepared",
    "authorized",
    "installing",
    "verifying",
    "restoring",
    "committed",
    "restored",
    "recovery-failed",
  ]),
  authorization: z.unknown().nullable(),
  steps: z.array(stepSchema),
  verificationProof: readinessProofSchema.nullable(),
  restorationProof: readinessProofSchema.nullable(),
  unchangedOriginal: z.object({sha256: hash, observedAt:z.object({bootId:z.string().min(1),millis:z.number().int().nonnegative()}).strict()}).strict().nullable().optional(),
});
const grantSchema = z
  .object({
    schema: z.literal(1),
    authorization: z.unknown(),
    requestId: id,
    fingerprint: hash,
    nativeSessionId: id,
  })
  .strict();
const denied = () =>
  new CoreError(
    "not_allowed",
    "Native transaction authority could not be verified",
    "Retain the transaction for authenticated recovery.",
  );
export function nativeTransactionDirectory(
  ctx: Ctx,
  installationId: string,
  transactionId: string,
): string {
  assertIdentifier(installationId);
  assertIdentifier(transactionId);
  let path = realpathSync(ctx.pacerHome);
  for (const part of [
    "desktop-updates",
    "native",
    installationId,
    transactionId,
  ]) {
    path = join(path, part);
    const s = lstatSync(path);
    if (
      !s.isDirectory() ||
      s.isSymbolicLink() ||
      s.uid !== process.getuid?.() ||
      s.mode & 0o077
    )
      throw denied();
  }
  return path;
}
export function privateNativeBytes(path: string): Buffer {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077 ||
      stat.size > 262144
    )
      throw denied();
    const bytes = Buffer.alloc(262145);
    let size = 0;
    while (size < bytes.length) {
      const n = readSync(fd, bytes, size, bytes.length - size, null);
      if (!n) break;
      size += n;
    }
    if (size > 262144) throw denied();
    return bytes.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}
export function sameNativeValue(a: unknown, b: unknown): boolean {
  const canonical = (value: any): any =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((k) => [k, canonical(value[k])]),
          )
        : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
/** Read-only bounded snapshots; helper remains the sole native journal writer. */
export function readNativeTransaction(ctx: Ctx, installationId: string, transactionId: string) {
  return readNativeRecord(ctx, installationId, transactionId, false);
}
/** Cleanup only: immutable original receipt/grant survives a later core transaction. */
export function readNativeCleanup(ctx: Ctx, installationId: string, transactionId: string) {
  const tx = readNativeRecord(ctx, installationId, transactionId, true);
  if (!["committed", "restored"].includes(tx.journal.state)) throw denied();
  if (!tx.authorization) {
    const backup = z.object({sha256:hash}).parse(tx.manifest.oldBundleBackup);
    if (tx.journal.state !== "restored" || tx.journal.unchangedOriginal?.sha256 !== backup.sha256 || tx.journal.steps.some(step =>
      !["prepare-backup", "arm-recovery", "release-reservation", "retire-recovery"].includes(String(step.action.kind)))) throw denied();
  }
  return tx;
}
function readNativeRecord(ctx: Ctx, installationId: string, transactionId: string, cleanup: boolean) {
  try {
    const dir = nativeTransactionDirectory(ctx, installationId, transactionId),
      bytes = privateNativeBytes(join(dir, "prepared.json"));
    const digest = createHash("sha256").update(bytes).digest("hex"),
      manifest = manifestSchema.parse(JSON.parse(bytes.toString()));
    const command = parseAdapterCommand({
      ...(manifest.binding as object),
      command: "install",
      target: manifest.target,
      candidate: manifest.candidate,
    });
    if (command.command !== "install") throw denied();
    if (
      command.installationId !== installationId ||
      command.transactionId !== transactionId ||
      command.target.id !== installationId ||
      realpathSync(command.target.pacerHome) !== realpathSync(ctx.pacerHome)
    )
      throw denied();
    const journal = journalSchema.parse(
      JSON.parse(privateNativeBytes(join(dir, "journal.json")).toString()),
    );
    if (
      journal.manifestSha256 !== digest ||
      (command.target.ownership === "managed" &&
        manifest.oldServiceExecutable !==
          join(command.target.appPath, "Contents/Resources/pacer"))
    )
      throw denied();
    const record = readUpdate(ctx, installationId),
      receipt = record.requestHistory.find(
        (r) =>
          r.action === "restart" &&
          r.transactionId === transactionId &&
          (cleanup || !record.requestedBy ||
            r.fingerprint ===
              requestFingerprint({
                version: command.candidate.version,
                clientId: record.requestedBy,
              })),
      );
    // Completed records clear ephemeral requester fields; their matching restart
    // receipt remains and the immutable prepared authority retains its binding.
    if (
      (!cleanup && (record.transactionId !== transactionId ||
      !sameNativeValue(record.candidate, command.candidate))) ||
      !receipt ||
      command.revision > record.revision ||
      (!cleanup && record.phase === "reserved" && command.revision !== record.revision)
    )
      throw denied();
    let authorization: null | ReturnType<typeof parseInstallAuthorization> =
      null;
    if (journal.authorization !== null) {
      authorization = parseInstallAuthorization(journal.authorization);
      const binding = Object.fromEntries(
        Object.entries(command).filter(
          ([k]) => !["command", "candidate", "target"].includes(k),
        ),
      );
      if (
        !sameNativeValue(
          Object.fromEntries(
            Object.entries(authorization).filter(
              ([k]) =>
                ![
                  "kind",
                  "sequence",
                  "reservationId",
                  "journalSha256",
                ].includes(k),
            ),
          ),
          binding,
        ) ||
        authorization.journalSha256 !== digest ||
        authorization.reservationId !== transactionId
      )
        throw denied();
      const grant = grantSchema.parse(
        JSON.parse(
          privateNativeBytes(join(dir, "service-grant.json")).toString(),
        ),
      );
      if (
        !sameNativeValue(grant.authorization, authorization) ||
        grant.requestId !== receipt!.requestId ||
        grant.fingerprint !== receipt!.fingerprint ||
        grant.nativeSessionId !== manifest.nativeSessionId
      )
        throw denied();
    }
    if (!["preparing", "prepared", ...(cleanup ? ["restored"] : [])].includes(journal.state) && !authorization)
      throw denied();
    for (const [index, step] of journal.steps.entries()) {
      if (step.action.kind !== "stop-unready-candidate-service") continue;
      const action = z.object({kind:z.literal("stop-unready-candidate-service"),launchId:hash}).strict().parse(step.action);
      if (!authorization || command.target.ownership !== "managed" || !["restoring","restored","recovery-failed"].includes(journal.state) || !step.intentBootId ||
          step.intentRevision > journal.revision ||
          (step.evidence !== null && !sameNativeValue(step.evidence,{kind:"complete"}))) throw denied();
      const launchIndex = journal.steps.findIndex(s => s.intentBootId === step.intentBootId &&
        sameNativeValue(s.action,{kind:"launch",role:"service",release:"candidate",launchId:action.launchId}));
      if (launchIndex < 0 || launchIndex >= index || journal.steps[launchIndex].evidence !== null ||
          journal.steps.some(s => s.action.kind === "launch" && s.action.role === "desktop" && s.action.release === "candidate")) throw denied();
      for (const prerequisite of [
        {kind:"suppress-lifecycle"},
        {kind:"stop",role:"desktop",process:manifest.oldDesktop},
        {kind:"stop",role:"service",process:manifest.oldService},
        {kind:"install-candidate"},{kind:"switch-registration"},
      ]) if (!journal.steps.slice(0,launchIndex).some(s => sameNativeValue(s.action,prerequisite) && sameNativeValue(s.evidence,{kind:"complete"}))) throw denied();
      if (journal.steps.slice(0,index).some(s => sameNativeValue(s.action,action))) throw denied();
    }
    return {
      dir,
      digest,
      manifest,
      command,
      journal,
      authorization,
      record,
      receipt: receipt!,
    };
  } catch {
    throw denied();
  }
}
export function verifyNativeLaunch(
  ctx: Ctx,
  ticket: LaunchTicket,
  desktop: z.infer<typeof nativeProcessSchema>,
) {
  const tx = readNativeTransaction(
    ctx,
    ticket.installationId,
    ticket.transactionId,
  );
  if (!tx.authorization) throw denied();
  const intent = tx.journal.steps.find(
    (step) =>
      step.action.kind === "launch" &&
      step.action.role === "desktop" &&
      step.action.launchId === ticket.launchId,
  );
  if (
    !intent ||
    ticket.nonce !== ticket.launchId ||
    intent.intentBootId !== desktop.bootId ||
    !["old", "candidate"].includes(String(intent.action.release))
  )
    throw denied();
  const release = intent.action.release;
  const version =
    release === "candidate"
      ? tx.command.candidate.version
      : tx.command.target.version;
  if (ticket.desktopVersion !== version) throw denied();
  // The fresh signed peer plus private launch capability closes the effect-before-
  // completion crash gap. If completion exists it must agree with the fresh peer.
  if (intent.evidence !== null) {
    const evidence = launchEvidence.parse(intent.evidence).launch;
    if (
      evidence.launchId !== ticket.launchId ||
      evidence.role !== "desktop" ||
      evidence.release !== release ||
      !sameNativeValue(evidence.process, desktop) ||
      evidence.nativeSessionId !== ticket.nativeSessionId ||
      evidence.version !== version
    )
      throw denied();
  }
  const serviceLaunch = tx.journal.steps
    .flatMap((step) => {
      const evidence = launchEvidence.safeParse(step.evidence);
      return evidence.success ? [evidence.data.launch] : [];
    })
    .find((launch) => launch.role === "service" && launch.release === release);
  const service =
    tx.command.target.ownership === "attached"
      ? tx.manifest.oldService
      : serviceLaunch?.process;
  const serviceVersion =
    tx.command.target.ownership === "attached"
      ? tx.manifest.oldServiceVersion
      : version;
  if (
    !sameNativeValue(service, ticket.service) ||
    ticket.serviceVersion !== serviceVersion
  )
    throw denied();
  return tx;
}

/** Service-owned immutable continuation receipt. The helper remains the sole journal writer. */
export function grantNativeTransaction(
  tx: ReturnType<typeof readNativeTransaction>,
): void {
  if (
    tx.record.phase !== "reserved" ||
    tx.authorization ||
    tx.journal.state !== "prepared" ||
    !tx.record.requestedBy
  )
    throw denied();
  const { command: _, target: __, candidate: ___, ...binding } = tx.command;
  const authorization = parseInstallAuthorization({
    ...binding,
    kind: "authorize-install",
    reservationId: tx.command.transactionId,
    journalSha256: tx.digest,
  });
  const value = {
    schema: 1,
    authorization,
    requestId: tx.receipt.requestId,
    fingerprint: tx.receipt.fingerprint,
    nativeSessionId: tx.manifest.nativeSessionId,
  };
  const path = join(tx.dir, "service-grant.json"),
    temporary = join(tx.dir, `.service-grant-${randomUUID()}`);
  const fd = openSync(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temporary, path);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "EEXIST" ||
      !sameNativeValue(
        grantSchema.parse(JSON.parse(privateNativeBytes(path).toString())),
        value,
      )
    )
      throw denied();
  } finally {
    unlinkSync(temporary);
  }
  const directory = openSync(tx.dir, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

/** Read pending service launch intents before work scheduling. No environment launch ID is trusted. */
export function discoverServiceLaunch(
  ctx: Ctx,
  executable: string,
  version: string,
  process: z.infer<typeof nativeProcessSchema>,
) {
  let files: string[];
  try {
    files = readdirSync(join(ctx.pacerHome, "desktop-updates"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw denied();
  }
  let found: null | {
    installationId: string;
    transactionId: string;
    evidence: z.infer<typeof launchEvidence>["launch"];
  } = null;
  for (const file of files) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json$/.test(file)) continue;
    const id = file.slice(0, -5),
      record = readUpdate(ctx, id);
    if (
      !record.transactionId ||
      ![
        "reserved",
        "installing",
        "verifying",
        "rolling-back",
        "recovery-failed",
      ].includes(record.phase)
    )
      continue;
    const tx = readNativeTransaction(ctx, id, record.transactionId);
    if (!tx.authorization || tx.command.target.ownership !== "managed")
      continue;
    const step = tx.journal.steps.findLast(
      (step) => step.action.kind === "launch" && step.action.role === "service",
    );
    // launchd may restart a managed service after reboot. Keep admission closed
    // and expose authenticated maintenance context, but no stale launch evidence.
    if (!step || step.intentBootId !== process.bootId) continue;
    const release = z.enum(["old", "candidate"]).parse(step.action.release),
      launchId = hash.parse(step.action.launchId);
    if (
      executable !==
      (release === "old"
        ? tx.manifest.oldServiceExecutable
        : join(tx.command.target.appPath, "Contents/Resources/pacer"))
    )
      throw denied();
    if (
      version !==
        (release === "candidate"
          ? tx.command.candidate.version
          : tx.manifest.oldServiceVersion)
    )
      throw denied();
    const evidence = {
      role: "service" as const,
      release,
      launchId,
      process,
      nativeSessionId: launchId,
      version,
    };
    if (
      step.evidence !== null &&
      !sameNativeValue(launchEvidence.parse(step.evidence).launch, evidence)
    )
      throw denied();
    if (found) throw denied();
    found = {
      installationId: id,
      transactionId: record.transactionId,
      evidence,
    };
  }
  return found;
}
