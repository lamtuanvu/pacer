/** Candidate-free native adoption authority. Only authenticated control consumes these records. */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CoreError } from "../../core/errors";
import type { Ctx } from "../../types";
import { adoptionAuthoritySchema } from "./adoption-state";
import { readAdoption, readTerminalAdoption } from "./adoption-store";
import { parseAdapterCommand, parseInstallAuthorization } from "./adapter";
import {
  nativeProcessSchema,
  nativeTransactionDirectory,
  privateNativeBytes,
  sameNativeValue,
} from "./native-record";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const stamp = z.object({ bootId: z.string().min(1), millis: integer }).strict();
const asset = z
  .object({
    relativePath: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
    sha256: hash,
  })
  .strict();
const branch = z.enum(["managed", "original"]);
const branchPlan = z
  .object({
    branch,
    launchId: hash,
    nonce: hash,
    executable: z.string().startsWith("/"),
    version: z.string(),
    installationId: id,
  })
  .strict();
export const adoptionReconnectSchema = z
  .object({
    schema: z.literal(1),
    kind: z.literal("adoption"),
    installationId: id,
    transactionId: id,
    nativeSessionId: id,
    manifestSha256: hash,
    desktop: nativeProcessSchema,
    recovery: z.boolean(),
    managed: branchPlan.nullable(),
    original: branchPlan,
  })
  .strict()
  .refine(
    (p) =>
      p.recovery === (p.managed === null) &&
      p.original.branch === "original" &&
      p.original.nonce === p.original.launchId &&
      p.original.installationId === p.installationId &&
      (!p.managed ||
        (p.managed.branch === "managed" &&
          p.managed.launchId !== p.original.launchId &&
          p.managed.nonce === p.managed.launchId &&
          p.managed.installationId !== p.installationId)),
  );
export type AdoptionReconnectPlan = z.infer<typeof adoptionReconnectSchema>;
export const adoptionReadinessSchema = z
  .object({
    installationId: id,
    transactionId: id,
    resultingInstallationId: id,
    branch,
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
export type AdoptionReadinessProof = z.infer<typeof adoptionReadinessSchema>;
const manifestSchema = z
  .object({
    schema: z.literal(1),
    transactionKind: z.literal("adoption"),
    binding: z.unknown(),
    source: adoptionAuthoritySchema,
    request: z.object({ requestId: id, fingerprint: hash }).strict(),
    expectedNewInstallationId: id,
    managedLaunchId: hash,
    originalLaunchId: hash,
    oldRegistration: asset,
    newRegistration: asset,
    recoveryJob: z
      .object({ label: z.string().min(1).max(128), helper: asset })
      .strict(),
  })
  .strict();
const recoveryCapability = z
  .object({
    desktop: nativeProcessSchema,
    originalLaunchId: hash,
    bootId: z.string().min(1),
    nativeSessionId: id,
  })
  .strict()
  .refine((c) => c.desktop.bootId === c.bootId);
const action = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("backup-registration") }).strict(),
  ...(
    [
      "arm-recovery",
      "prepare-reconnect",
      "suppress-lifecycle",
      "release-reservation",
      "retire-recovery",
    ] as const
  ).map((kind) => z.object({ kind: z.literal(kind) }).strict()),
  z
    .object({
      kind: z.literal("prepare-recovery-reconnect"),
      capability: recoveryCapability,
    })
    .strict(),
  z
    .object({ kind: z.literal("launch-recovery-desktop"), launchId: hash })
    .strict(),
  z
    .object({ kind: z.literal("stop-service"), process: nativeProcessSchema })
    .strict(),
  z.object({ kind: z.literal("switch-registration"), branch }).strict(),
  z
    .object({ kind: z.literal("launch-service"), branch, launchId: hash })
    .strict(),
]);
const launch = z
  .object({
    role: z.literal("service"),
    release: z.enum(["old", "candidate"]),
    launchId: hash,
    process: nativeProcessSchema,
    nativeSessionId: id,
    version: z.string(),
  })
  .strict();
const evidence = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("complete") }).strict(),
  z
    .object({
      kind: z.literal("desktop-spawned"),
      process: nativeProcessSchema,
    })
    .strict(),
  z.object({ kind: z.literal("launched"), branch, launch }).strict(),
]);
const journalSchema = z
  .object({
    schema: z.literal(1),
    transactionKind: z.literal("adoption"),
    revision: integer,
    manifestSha256: hash,
    state: z.enum([
      "preparing",
      "prepared",
      "authorized",
      "switching",
      "verifying",
      "restoring",
      "committed",
      "restored",
      "recovery-failed",
    ]),
    authorization: z.unknown().nullable(),
    steps: z
      .array(
        z
          .object({
            action,
            intentRevision: integer,
            intentBootId: z.string().min(1),
            evidence: evidence.nullable(),
          })
          .strict(),
      )
      .max(1024),
    verificationStarted: stamp.nullable(),
    restorationStarted: stamp.nullable(),
    restorationHistory: z.array(stamp).max(1024),
    verificationProof: adoptionReadinessSchema.nullable(),
    restorationProof: adoptionReadinessSchema.nullable(),
    recoveryReconnects: z.array(recoveryCapability).max(16).default([]),
    unchangedRegistration: z
      .object({ sha256: hash, observedAt: stamp })
      .strict()
      .nullable(),
    error: z.unknown().nullable(),
    restorationCause: z.unknown().nullable().default(null),
  })
  .strict();
const grantSchema = z
  .object({
    schema: z.literal(1),
    transactionKind: z.literal("adoption"),
    authorization: z.unknown(),
    requestId: id,
    fingerprint: hash,
    nativeSessionId: id,
  })
  .strict();
const denied = () =>
  new CoreError(
    "not_allowed",
    "Native adoption authority could not be verified",
    "Retain the adoption transaction for authenticated recovery.",
  );
export function readNativeAdoption(
  ctx: Ctx,
  installationId: string,
  transactionId: string,
  cleanup = false,
) {
  try {
    const dir = nativeTransactionDirectory(ctx, installationId, transactionId),
      bytes = privateNativeBytes(join(dir, "adoption-prepared.json")),
      digest = createHash("sha256").update(bytes).digest("hex"),
      manifest = manifestSchema.parse(JSON.parse(bytes.toString()));
    const command = parseAdapterCommand({
      ...(manifest.binding as object),
      command: "adopt",
      target: manifest.source.target,
    });
    if (
      command.command !== "adopt" ||
      command.installationId !== installationId ||
      command.transactionId !== transactionId ||
      realpathSync(command.target.pacerHome) !== realpathSync(ctx.pacerHome) ||
      manifest.managedLaunchId === manifest.originalLaunchId ||
      manifest.expectedNewInstallationId === installationId ||
      manifest.recoveryJob.helper.relativePath !== "pacer-update-helper"
    )
      throw denied();
    const current = readAdoption(ctx, installationId),
      record =
        cleanup && current?.transactionId !== transactionId
          ? readTerminalAdoption(ctx, installationId, transactionId)
          : current,
      receipt = record?.receipts.find(
        (r) => r.action === "adopt" && r.transactionId === transactionId,
      );
    if (
      !record ||
      record.transactionId !== transactionId ||
      !receipt ||
      receipt.requestId !== manifest.request.requestId ||
      receipt.fingerprint !== manifest.request.fingerprint ||
      !sameNativeValue(record.authority, manifest.source) ||
      command.revision > record.revision ||
      (record.phase === "reserved" && command.revision !== record.revision)
    )
      throw denied();
    const journal = journalSchema.parse(
      JSON.parse(
        privateNativeBytes(join(dir, "adoption-journal.json")).toString(),
      ),
    );
    if (journal.manifestSha256 !== digest) throw denied();
    const { command: _, target: __, ...binding } = command;
    let authorization: ReturnType<typeof parseInstallAuthorization> | null =
      null;
    if (journal.authorization !== null) {
      authorization = parseInstallAuthorization(journal.authorization);
      if (
        !sameNativeValue(authorization, {
          ...binding,
          kind: "authorize-install",
          reservationId: transactionId,
          journalSha256: digest,
        })
      )
        throw denied();
      const grant = grantSchema.parse(
        JSON.parse(
          privateNativeBytes(
            join(dir, "service-adoption-grant.json"),
          ).toString(),
        ),
      );
      if (
        !sameNativeValue(grant.authorization, authorization) ||
        grant.requestId !== receipt.requestId ||
        grant.fingerprint !== receipt.fingerprint ||
        grant.nativeSessionId !== manifest.source.nativeSessionId
      )
        throw denied();
    }
    if (
      !authorization &&
      !["preparing", "prepared", ...(cleanup ? ["restored"] : [])].includes(
        journal.state,
      )
    )
      throw denied();
    if (cleanup) {
      if (!["committed", "restored"].includes(journal.state)) throw denied();
      if (
        !authorization &&
        (journal.unchangedRegistration?.sha256 !==
          manifest.oldRegistration.sha256 ||
          journal.steps.some(
            (s) =>
              ![
                "backup-registration",
                "arm-recovery",
                "release-reservation",
                "retire-recovery",
              ].includes(s.action.kind),
          ))
      )
        throw denied();
    }
    if (
      new Set(journal.recoveryReconnects.map((c) => c.bootId)).size !==
      journal.recoveryReconnects.length
    )
      throw denied();
    for (const capability of journal.recoveryReconnects) {
      if (
        !authorization ||
        capability.bootId === manifest.source.bootId ||
        !journal.steps.some(
          (s) =>
            s.action.kind === "prepare-recovery-reconnect" &&
            s.intentBootId === capability.bootId &&
            sameNativeValue(s.action.capability, capability),
        ) ||
        !journal.steps.some(
          (s) =>
            s.action.kind === "launch-service" &&
            s.action.branch === "original" &&
            s.action.launchId === capability.originalLaunchId &&
            s.intentBootId === capability.bootId,
        )
      )
        throw denied();
    }
    for (const [index, step] of journal.steps.entries()) {
      if (journal.steps.slice(0,index).some(previous => sameNativeValue(previous.action,step.action) &&
          (!["suppress-lifecycle","switch-registration"].includes(step.action.kind) || previous.intentBootId === step.intentBootId))) throw denied();
      if (step.intentRevision > journal.revision) throw denied();
      if (step.action.kind === "launch-service") {
        const selected = step.action.branch,
          launchId =
            selected === "managed"
              ? manifest.managedLaunchId
              : step.intentBootId === manifest.source.bootId
                ? manifest.originalLaunchId
                : step.action.launchId;
        if (
          selected === "managed" &&
          step.intentBootId !== manifest.source.bootId
        )
          throw denied();
        if (
          selected === "original" &&
          step.intentBootId !== manifest.source.bootId &&
          journal.steps.filter(
            (s) =>
              s.action.kind === "launch-service" &&
              s.action.branch === "original" &&
              s.intentBootId === step.intentBootId,
          ).length !== 1
        )
          throw denied();
        if (step.action.launchId !== launchId) throw denied();
        if (step.evidence) {
          if (
            step.evidence.kind !== "launched" ||
            step.evidence.branch !== selected ||
            step.evidence.launch.launchId !== launchId ||
            step.evidence.launch.nativeSessionId !== launchId ||
            step.evidence.launch.release !==
              (selected === "managed" ? "candidate" : "old") ||
            step.evidence.launch.version !==
              (selected === "managed"
                ? manifest.source.target.version
                : manifest.source.serviceVersion)
          )
            throw denied();
        }
      } else if (step.action.kind === "launch-recovery-desktop") {
        if (
          !authorization ||
          step.intentBootId === manifest.source.bootId ||
          (step.evidence &&
            (step.evidence.kind !== "desktop-spawned" ||
              step.evidence.process.bootId !== step.intentBootId))
        )
          throw denied();
      } else if (step.evidence && step.evidence.kind !== "complete")
        throw denied();
    }
    return {
      dir,
      digest,
      manifest,
      command,
      journal,
      authorization,
      record,
      receipt,
    };
  } catch {
    throw denied();
  }
}
export function grantNativeAdoption(
  tx: ReturnType<typeof readNativeAdoption>,
): void {
  if (
    tx.record.phase !== "reserved" ||
    tx.authorization ||
    tx.journal.state !== "prepared"
  )
    throw denied();
  const { command: _, target: __, ...binding } = tx.command;
  const value = grantSchema.parse({
    schema: 1,
    transactionKind: "adoption",
    authorization: parseInstallAuthorization({
      ...binding,
      kind: "authorize-install",
      reservationId: tx.command.transactionId,
      journalSha256: tx.digest,
    }),
    requestId: tx.receipt.requestId,
    fingerprint: tx.receipt.fingerprint,
    nativeSessionId: tx.manifest.source.nativeSessionId,
  });
  const path = join(tx.dir, "service-adoption-grant.json"),
    temporary = join(tx.dir, `.adoption-grant-${randomUUID()}`),
    fd = openSync(
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
export function adoptionReconnectPlan(
  tx: ReturnType<typeof readNativeAdoption>,
): AdoptionReconnectPlan {
  const m = tx.manifest,
    capability = tx.journal.recoveryReconnects.at(-1);
  return adoptionReconnectSchema.parse({
    schema: 1,
    kind: "adoption",
    installationId: tx.command.installationId,
    transactionId: tx.command.transactionId,
    nativeSessionId: capability?.nativeSessionId ?? m.source.nativeSessionId,
    manifestSha256: tx.digest,
    desktop: capability?.desktop ?? m.source.desktop,
    recovery: !!capability,
    managed: capability
      ? null
      : {
          branch: "managed",
          launchId: m.managedLaunchId,
          nonce: m.managedLaunchId,
          executable: m.source.newServiceExecutable,
          version: m.source.target.version,
          installationId: m.expectedNewInstallationId,
        },
    original: {
      branch: "original",
      launchId: capability?.originalLaunchId ?? m.originalLaunchId,
      nonce: capability?.originalLaunchId ?? m.originalLaunchId,
      executable: m.source.oldServiceExecutable,
      version: m.source.serviceVersion,
      installationId: m.source.target.id,
    },
  });
}

/** Fresh service incarnation must match a durable launch intent, even before its evidence is appended. */
export function verifyAdoptionLaunch(
  ctx: Ctx,
  plan: AdoptionReconnectPlan,
  desktop: z.infer<typeof nativeProcessSchema>,
  service: z.infer<typeof nativeProcessSchema>,
  executable: string,
  version: string,
) {
  const tx = readNativeAdoption(ctx, plan.installationId, plan.transactionId);
  if (
    !tx.authorization ||
    !sameNativeValue(plan, adoptionReconnectPlan(tx)) ||
    !sameNativeValue(desktop, plan.desktop)
  )
    throw denied();
  const selected = ([plan.managed, plan.original] as const).find(
    (p) => p && p.executable === executable && p.version === version,
  );
  if (!selected) throw denied();
  const step = tx.journal.steps.find(
    (s) =>
      s.action.kind === "launch-service" &&
      s.action.branch === selected.branch &&
      s.action.launchId === selected.launchId &&
      s.intentBootId === service.bootId,
  );
  if (
    !step ||
    (step.evidence &&
      (step.evidence.kind !== "launched" ||
        !sameNativeValue(step.evidence.launch.process, service)))
  )
    throw denied();
  return { tx, selected };
}
