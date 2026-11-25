import { nativeServiceArgv } from "./native-service-argv";
import {
  readAdoption,
  listAdoptions,
  type AdoptionRecord,
} from "./adoption-store";
import { adoptionPending } from "./adoption-state";
import {
  adoptionReconnectSchema,
  adoptionReadinessSchema,
  adoptionReconnectPlan,
  readNativeAdoption,
  grantNativeAdoption,
  verifyAdoptionLaunch,
  type AdoptionReconnectPlan,
  type AdoptionReadinessProof,
} from "./native-adoption";
/** Private service composition. Public client registration cannot reach this channel. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ParentHelperSpawner } from "./native-parent-helper";
import { helperRefused, NativeHelperDataFolderError, NativeHelperIntegrityError, NativeHelperStorageError } from "./native-helper-errors";
import {
  closeSync,
  chmodSync,
  constants,
  copyFileSync,
  fsyncSync,
  fstatSync,
  readSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { CoreError } from "../../core/errors";
import type { Ctx } from "../../types";
import {
  desktopServiceLabel,
  parseDesktopServiceRegistration,
  servicePath,
} from "../../service";
import { currentVersion } from "../version";
import {
  DarwinAuthority,
  nativeSocketPath,
  enumerateNativeProcesses,
  type NativeProcess,
  type NativePeer,
} from "./native-os";
import {
  compiledNativeFixture,
  fixtureProcessInScope,
  verifyNativeFixture,
} from "./native-fixture";
import { freshHelperCleanup } from "./native-command-cleanup";
import { LocalNativeServer } from "./native-socket";
import type { PairedNativeBootstrap } from "./native-paired-bootstrap";
import type { NativeServiceOwner } from "./native-service-owner";
import {
  inspectInstallation,
  verifyInstallation,
  BUNDLED_CLI_PATH,
  BUNDLED_CORE_PATH,
  BUNDLED_HELPER_PATH,
  BUNDLE_RELEASE_PATH,
  parseBundleRelease,
} from "./identity";
import {
  ownProcessIdentity,
  processIdentity,
  sameProcess,
  type ProcessIdentity,
} from "./process-identity";
import {
  enrolledWorkProcesses,
  hasReservation,
  releaseReservation,
  reserveIdle,
} from "./admission";
import {
  parseAdapterCommand,
  type PreparedFrame,
  type VerifiedPipe,
  type VerifiedPipeFactory,
  encodeFrame,
} from "./adapter";
import { readUpdate } from "./store";
import {
  launchTicketSchema,
  nativeProcessSchema,
  readNativeTransaction,
  readNativeCleanup,
  grantNativeTransaction,
  discoverServiceLaunch,
  readinessProofSchema,
  sameNativeValue,
  verifyNativeLaunch,
  type LaunchTicket,
  type NativeReadinessProof,
} from "./native-record";
import type { Installation, UpdateRecord } from "./types";
import type { NativeAuthorityProvider, VerifiedNativeSession } from "./service";

const denied = () =>
  new CoreError(
    "not_allowed",
    "Authenticated native control is unavailable",
    "Use the supported signed desktop and service baseline.",
  );
/** Fail closed, but classify local signature/hash/process refusals separately from a
 *  missing session: a damaged or tampered helper is a real failure, not a network check. */
const helperIntegrityCheck = <T>(check: () => T): T => {
  try {
    return check();
  } catch (error) {
    if (error instanceof NativeHelperIntegrityError) throw error;
    throw new NativeHelperIntegrityError("Desktop update helper failed integrity verification", error);
  }
};
/** Keep an integrity refusal from being rewritten as a generic "unavailable" by cleanup catches. */
const denyUnlessIntegrity = (error: unknown) =>
  error instanceof NativeHelperIntegrityError ? error : denied();
/** Named hello failure; never includes nonces, tokens or challenge material. */
class HelloRejection extends Error {
  constructor(
    readonly step: string,
    detail?: string,
  ) {
    super(detail ? `${step}: ${detail}` : step);
    this.name = "HelloRejection";
  }
}
const helloDenied = (step: string, detail?: string) => new HelloRejection(step, detail);
const HELLO_REJECTION_LOG_INTERVAL_MS = 5 * 60_000;
const helloRejectionLogAt = new Map<string, number>();
/** Rate-limited serve.log line for a failed native hello (once per reason per 5 minutes). */
export function logHelloRejection(reason: string, now = Date.now()): void {
  const last = helloRejectionLogAt.get(reason);
  if (last !== undefined && now - last < HELLO_REJECTION_LOG_INTERVAL_MS) return;
  helloRejectionLogAt.set(reason, now);
  console.error(`pacer: native hello rejected: ${reason}`);
}
export function resetHelloRejectionLogForTests(): void {
  helloRejectionLogAt.clear();
}
function helloRejectionReason(error: unknown): string {
  if (error instanceof HelloRejection) return error.message;
  if (error instanceof z.ZodError) return "helloSchema";
  if (error instanceof CoreError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "denied";
}
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema = z
  .object({
    schema: z.literal(1),
    commandId: id,
    installationId: id,
    transactionId: id.nullable(),
    revision: z.number().int().nonnegative(),
    nonce: hash,
  })
  .strict();
type Binding = z.infer<typeof bindingSchema>;
const helloSchema = z
  .object({
    schema: z.literal(1),
    kind: z.literal("hello"),
    role: z.enum(["desktop", "helper"]),
    version: z.string().min(1),
    nonce: hash,
    challenge: hash,
    ticket: launchTicketSchema.optional(),
    adoption: adoptionReconnectSchema.optional(),
  })
  .strict();
const requestBase = {
  schema: z.literal(1),
  sessionId: id,
  sequence: z.number().int().positive(),
};
const requestSchema = z.discriminatedUnion("kind", [
  z.object({ ...requestBase, kind: z.literal("heartbeat") }).strict(),
  z.object({ ...requestBase, kind: z.literal("op"), op: z.string().min(1), params: z.unknown() }).strict(),
  z.object({ ...requestBase, kind: z.literal("snapshot") }).strict(),
  z.object({ ...requestBase, kind: z.literal("subscribe-events") }).strict(),
  ...(
    [
      "adoption-context",
      "adoption-release",
      "adoption-suppress",
      "adoption-recovery-context",
    ] as const
  ).map((kind) =>
    z
      .object({
        ...requestBase,
        kind: z.literal(kind),
        transactionKind: z.literal("adoption"),
        binding: bindingSchema,
      })
      .strict(),
  ),
  z
    .object({
      ...requestBase,
      kind: z.literal("adoption-shutdown"),
      transactionKind: z.literal("adoption"),
      binding: bindingSchema,
      expected: nativeProcessSchema,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      kind: z.literal("adoption-reconnect"),
      transactionKind: z.literal("adoption"),
      binding: bindingSchema,
      plan: adoptionReconnectSchema,
    })
    .strict(),
  ...(["adoption-observe-launch", "adoption-readiness"] as const).map((kind) =>
    z
      .object({
        ...requestBase,
        kind: z.literal(kind),
        transactionKind: z.literal("adoption"),
        binding: bindingSchema,
        branch: z.enum(["managed", "original"]),
      })
      .strict(),
  ),
  z
    .object({
      ...requestBase,
      kind: z.literal("desktop-ready"),
      validStateRead: z.literal(true),
      protocol: z.literal(3),
      serviceVersion: z.string(),
      proof: readinessProofSchema.nullable(),
      adoptionProof: adoptionReadinessSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      kind: z.literal("helper-context"),
      binding: bindingSchema,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      kind: z.literal("query-readiness"),
      installationId: id,
      transactionId: id,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      kind: z.literal("observe-launch"),
      binding: bindingSchema,
      launchId: hash,
    })
    .strict(),
  ...(
    [
      "suppress-lifecycle",
      "shutdown-service",
      "shutdown-desktop",
      "release-reservation",
    ] as const
  ).map((kind) =>
    z
      .object({
        ...requestBase,
        kind: z.literal(kind),
        binding: bindingSchema,
        expected: nativeProcessSchema.nullable(),
      })
      .strict(),
  ),
  z.object({ ...requestBase, kind: z.literal("fixture-cleanup") }).strict(),
  z
    .object({ ...requestBase, kind: z.literal("effect-ack"), effectId: id })
    .strict(),
]);
export interface NativeChannel {
  auditToken: Uint8Array;
  closed: Promise<void>;
  onFrame: (frame: unknown) => void;
  send(frame: unknown): Promise<void>;
  close(): void;
}
type Connection = {
  peer: NativeChannel;
  identity: NativePeer;
  sessionId: string;
  clientId: string;
  sequence: number;
  installation: Installation | null;
  ticket: LaunchTicket | null;
  adoption: AdoptionReconnectPlan | null;
  adoptionProof: AdoptionReadinessProof | null;
  recoveryInstallationId: string | null;
  ready: boolean;
  dead: boolean;
  proof: NativeReadinessProof | null;
  maintenance: string | null;
};
type Authority = Pick<DarwinAuthority, "verifyPeer" | "verifyStatic">;
export interface NativeBridgeOptions {
  port: number;
  authority: Authority;
  /**
   * Internal system adapter. Never accepted from an API or environment.
   * Identity checks always run. Process coverage runs only when `coverage` is set
   * (install/apply/takeover/adoption effects), never for hello or read-only reverify.
   */
  verifyService: (options?: { coverage?: boolean }) => Promise<void>;
  shutdown?: () => void;
  /** Verified private bootstrap only; never constructed from public or ambient claims. */
  paired?: PairedNativeBootstrap;
}

export class NativeControlBridge implements NativeAuthorityProvider {
  private server?: LocalNativeServer;
  private connections = new Set<Connection>();
  private listeners = new Set<() => void>();
  private sessionsByConnection = new Map<Connection, VerifiedNativeSession>();
  private pendingEffects = new Map<
    string,
    { connection: Connection; confirmExit: boolean; resolve: () => void; reject: () => void }
  >();
  private eventSubscriptions = new Map<string, Connection>();
  private service: ProcessIdentity;
  private serviceExecutable: string;
  private shutdown?: () => void;
  private serviceLaunch: ReturnType<typeof discoverServiceLaunch> = null;
  constructor(
    private getCtx: () => Ctx,
    private options: NativeBridgeOptions,
  ) {
    const own = ownProcessIdentity(), paired = options.paired;
    if (!own || paired && (!sameProcess(paired.owner.transport, own)
      || !sameProcess(paired.listener.owner, paired.owner.process)
      || paired.owner.process.pid !== process.ppid || sameProcess(paired.owner.process, own))) throw denied();
    this.service = { ...(paired?.owner.process ?? own) };
    this.serviceExecutable = paired?.owner.executable ?? realpathSync(process.execPath);
    this.shutdown = paired?.shutdown ?? options.shutdown;
  }
  listen(): void {
    this.serviceLaunch = discoverServiceLaunch(
      this.getCtx(),
      this.serviceExecutable,
      currentVersion(),
      this.service!,
    );
    this.server = new LocalNativeServer(
      nativeSocketPath(
        this.getCtx().pacerHome,
        this.options.port,
        process.getuid!(),
      ),
      (peer) => this.accept(peer),
      this.options.paired?.listener,
    );
    // Subscribe to outbox notifications to push events over native socket
    import("../../link/store").then(({ subscribeOutbox }) => {
      subscribeOutbox(this.getCtx(), () => {
        this.pushOutboxEvents();
      });
    });
  }
  private pushOutboxEvents(): void {
    import("../../link/store").then(({ readOutboxSince, readLatest }) => {
      const ctx = this.getCtx();
      const snapshot = readLatest(ctx);
      const entries = readOutboxSince(ctx, snapshot.seq);
      for (const entry of entries) {
        this.broadcastEvent(entry.envelope.type, entry.envelope.data);
      }
    });
  }
  sessions(): readonly VerifiedNativeSession[] {
    return [...this.sessionsByConnection.values()].filter((session) =>
      session.alive(),
    );
  }
  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  private changed(): void {
    for (const callback of this.listeners) callback();
  }
  stop(): void {
    this.server?.close();
    for (const connection of this.connections) connection.peer.close();
  }
  accept(peer: NativeChannel): void {
    const challenge = randomBytes(32).toString("hex");
    let connection: Connection | undefined,
      pending = 0,
      dead = false,
      chain = Promise.resolve();
    const timeout = setTimeout(() => peer.close(), 10_000);
    timeout.unref();
    void peer.closed.then(() => {
      dead = true;
      clearTimeout(timeout);
      if (connection) {
        connection.dead = true;
        this.connections.delete(connection);
        this.sessionsByConnection.delete(connection);
        this.eventSubscriptions.delete(connection.sessionId);
        for (const [id, effect] of this.pendingEffects) {
          if (effect.connection === connection) {
            effect.reject();
            this.pendingEffects.delete(id);
          }
        }
        this.changed();
      }
    });
    peer.onFrame = (frame) => {
      if (++pending > 8) {
        peer.close();
        return;
      }
      chain = chain
        .then(async () => {
          if (dead) throw helloDenied("closed");
          if (!connection) {
            let hello: z.infer<typeof helloSchema>;
            try {
              hello = helloSchema.parse(frame);
            } catch (error) {
              if (error instanceof z.ZodError) throw helloDenied("helloSchema");
              throw error;
            }
            if (hello.challenge !== challenge)
              throw helloDenied("challenge mismatch");
            let identity: NativePeer;
            try {
              identity = this.options.authority.verifyPeer(
                peer.auditToken,
                hello.role,
              );
            } catch (error) {
              throw helloDenied(
                "verifyPeer",
                error instanceof Error ? error.message : undefined,
              );
            }
            try {
              await this.options.verifyService();
            } catch (error) {
              throw helloDenied(
                "verifyService",
                error instanceof Error ? error.message : undefined,
              );
            }
            let installation: Installation | null = null;
            let adoptionSession: string | undefined,
              recoveryInstallationId: string | null = null;
            if (hello.ticket && hello.adoption)
              throw helloDenied("ticket and adoption");
            if (hello.role === "desktop") {
              if (!identity.executable.endsWith(".app/Contents/MacOS/pacer"))
                throw helloDenied("verifyPeer", "desktop executable path");
              const app = dirname(dirname(dirname(identity.executable)));
              try {
                this.verifyBundle(app);
              } catch (error) {
                throw helloDenied(
                  "verifyBundle",
                  error instanceof Error ? error.message : undefined,
                );
              }
              try {
                installation = await inspectInstallation(this.getCtx(), app);
              } catch (error) {
                // Task requires the inspectInstallation refusal message in the local log.
                throw helloDenied(
                  "inspectInstallation",
                  error instanceof CoreError
                    ? error.message
                    : error instanceof Error
                      ? error.message
                      : undefined,
                );
              }
              if (hello.version !== installation.version)
                throw helloDenied("version mismatch");
              if (!hello.ticket && !hello.adoption) {
                const pending = listAdoptions(this.getCtx()).filter(
                  (r) =>
                    adoptionPending(r) &&
                    r.authority.target.appPath === installation!.appPath &&
                    r.authority.bootId !== identity.process.bootId,
                );
                if (pending.length > 1)
                  throw helloDenied("pending adoption count > 1");
                if (pending[0]) {
                  const tx = readNativeAdoption(
                    this.getCtx(),
                    pending[0].installationId,
                    pending[0].transactionId,
                  );
                  if (
                    !tx.authorization ||
                    !hasReservation(this.getCtx(), tx.command.transactionId)
                  )
                    throw helloDenied("adoption/ticket verification");
                  const original = tx.manifest.source.target;
                  for (const key of [
                    "appPath",
                    "bundleId",
                    "ownerUid",
                    "arch",
                    "pacerHome",
                    "port",
                    "serviceLabel",
                    "version",
                  ] as const)
                    if (original[key] !== installation[key])
                      throw helloDenied("adoption/ticket verification");
                  recoveryInstallationId = original.id;
                }
              }
              if (hello.adoption) {
                try {
                  const verified = verifyAdoptionLaunch(
                    this.getCtx(),
                    hello.adoption,
                    identity.process,
                    this.service!,
                    this.serviceExecutable,
                    currentVersion(),
                  );
                  if (installation.id !== verified.selected.installationId)
                    throw helloDenied("adoption/ticket verification");
                  adoptionSession = verified.selected.launchId;
                } catch (error) {
                  if (error instanceof HelloRejection) throw error;
                  throw helloDenied("adoption/ticket verification");
                }
              }
              if (hello.ticket) {
                try {
                  verifyNativeLaunch(
                    this.getCtx(),
                    hello.ticket,
                    identity.process,
                  );
                  if (!sameProcess(hello.ticket.service, this.service))
                    throw helloDenied("adoption/ticket verification");
                } catch (error) {
                  if (error instanceof HelloRejection) throw error;
                  throw helloDenied("adoption/ticket verification");
                }
              }
            } else if (hello.ticket || hello.adoption)
              throw helloDenied("adoption/ticket verification");
            try {
              this.options.authority.verifyPeer(
                peer.auditToken,
                hello.role,
                identity.process,
              );
            } catch (error) {
              throw helloDenied(
                "verifyPeer",
                error instanceof Error ? error.message : undefined,
              );
            }
            connection = {
              peer,
              identity,
              sessionId:
                adoptionSession ??
                hello.ticket?.nativeSessionId ??
                randomUUID(),
              clientId: randomUUID(),
              sequence: 0,
              installation,
              ticket: hello.ticket ?? null,
              adoption: hello.adoption ?? null,
              adoptionProof: null,
              recoveryInstallationId,
              ready: false,
              dead: false,
              proof: null,
              maintenance:
                hello.adoption?.transactionId ??
                hello.ticket?.transactionId ??
                null,
            };
            if (dead) throw helloDenied("closed");
            this.connections.add(connection);
            clearTimeout(timeout);
            await peer.send({
              schema: 1,
              kind: "registered",
              nonce: hello.nonce,
              sessionId: connection.sessionId,
              clientId: connection.clientId,
              serviceVersion: currentVersion(),
              installation,
            });
          } else await this.handle(connection, frame);
        })
        .catch((error) => {
          if (!connection) logHelloRejection(helloRejectionReason(error));
          peer.close();
        })
        .finally(() => {
          pending--;
        });
    };
    void peer
      .send({
        schema: 1,
        kind: "challenge",
        nonce: challenge,
        service: this.service,
        version: currentVersion(),
        port: this.options.port,
      })
      .catch(() => peer.close());
  }
  private verifyBundle(app: string): void {
    this.options.authority.verifyStatic(app, "desktop");
    this.options.authority.verifyStatic(join(app, BUNDLED_CLI_PATH), "cli");
    const metadata = parseBundleRelease(JSON.parse(readFileSync(join(app, BUNDLE_RELEASE_PATH), "utf8")));
    if (metadata.cliLayout === "paired") this.options.authority.verifyStatic(join(app, BUNDLED_CORE_PATH), "cli");
    this.options.authority.verifyStatic(
      join(app, BUNDLED_HELPER_PATH),
      "helper",
    );
  }
  private connection(session: VerifiedNativeSession): Connection {
    const connection = [...this.sessionsByConnection].find(
      ([, value]) => value === session,
    )?.[0];
    if (!connection || connection.dead || !connection.ready) throw denied();
    return connection;
  }
  async reverify(session: VerifiedNativeSession): Promise<void> {
    const connection = this.connection(session);
    this.options.authority.verifyPeer(
      connection.peer.auditToken,
      "desktop",
      session.desktop,
    );
    this.verifyBundle(session.installation.appPath);
    if (connection.adoption) {
      const verified = verifyAdoptionLaunch(
        this.getCtx(),
        connection.adoption,
        connection.identity.process,
        this.service!,
        this.serviceExecutable,
        currentVersion(),
      );
      await verifyInstallation(this.getCtx(), connection.installation!);
      if (
        !sameNativeValue(
          session.installation,
          verified.tx.manifest.source.target,
        )
      )
        throw denied();
    } else if (connection.recoveryInstallationId) {
      const record = readAdoption(
        this.getCtx(),
        connection.recoveryInstallationId,
      );
      if (
        !record ||
        !adoptionPending(record) ||
        record.authority.bootId === connection.identity.process.bootId
      )
        throw denied();
      const tx = readNativeAdoption(
        this.getCtx(),
        record.installationId,
        record.transactionId,
      );
      if (
        !tx.authorization ||
        !hasReservation(this.getCtx(), record.transactionId) ||
        !sameNativeValue(session.installation, tx.manifest.source.target)
      )
        throw denied();
      await verifyInstallation(this.getCtx(), connection.installation!);
    } else if (connection.ticket) {
      const tx = verifyNativeLaunch(
        this.getCtx(),
        connection.ticket,
        connection.identity.process,
      );
      const actual = await inspectInstallation(
        this.getCtx(),
        connection.installation!.appPath,
      );
      if (
        !sameNativeValue(actual, connection.installation) ||
        !sameNativeValue(session.installation, tx.command.target)
      )
        throw denied();
    } else await verifyInstallation(this.getCtx(), session.installation);
    await this.options.verifyService();
    if (connection.dead || !sameProcess(session.service, this.service))
      throw denied();
  }
  inspectAdoption(session: VerifiedNativeSession) {
    const connection = this.connection(session);
    if (
      session.installation.ownership !== "attached" ||
      connection.adoption ||
      connection.ticket ||
      connection.recoveryInstallationId
    )
      throw denied();
    return {
      target: session.installation,
      nativeSessionId: session.sessionId,
      desktopClientId: session.desktopClientId,
      bootId: session.bootId,
      desktop: session.desktop,
      service: session.service,
      serviceVersion: currentVersion(),
      oldServiceExecutable: this.serviceExecutable,
      newServiceExecutable: join(
        session.installation.appPath,
        BUNDLED_CLI_PATH,
      ),
    };
  }
  async authorizeAdoption(
    session: VerifiedNativeSession,
    record: AdoptionRecord,
    prepared: PreparedFrame,
  ): Promise<boolean> {
    await this.reverify(session);
    await this.options.verifyService({ coverage: true });
    if (
      !prepared.transactionId ||
      prepared.reservationId !== prepared.transactionId ||
      !hasReservation(this.getCtx(), prepared.transactionId)
    )
      throw denied();
    const tx = readNativeAdoption(
      this.getCtx(),
      prepared.installationId,
      prepared.transactionId,
    );
    const {
        kind: _,
        sequence: __,
        reservationId: ___,
        journalSha256: ____,
        ...binding
      } = prepared,
      { command: _____, target: ______, ...expected } = tx.command;
    if (
      !sameNativeValue(binding, expected) ||
      prepared.journalSha256 !== tx.digest ||
      !sameNativeValue(record, tx.record) ||
      !sameNativeValue(this.inspectAdoption(session), tx.manifest.source)
    )
      throw denied();
    grantNativeAdoption(tx);
    return true;
  }
  async verifyAdoptionOutcome(
    record: AdoptionRecord,
    outcome: "committed" | "restored",
  ) {
    const tx = readNativeAdoption(
      this.getCtx(),
      record.installationId,
      record.transactionId,
      true,
    );
    if (tx.journal.state !== outcome) throw denied();
    if (!tx.authorization) {
      this.verifyBundle(tx.manifest.source.target.appPath);
      await verifyInstallation(this.getCtx(), tx.manifest.source.target);
      return { installation: tx.manifest.source.target, attempted: false };
    }
    const proof =
      outcome === "committed"
        ? tx.journal.verificationProof
        : tx.journal.restorationProof;
    const connection = [...this.connections].find(
      (c) => c.ready && !c.dead && sameNativeValue(c.adoptionProof, proof),
    );
    if (!proof || !connection?.installation) throw denied();
    const session = this.sessionsByConnection.get(connection);
    if (!session) throw denied();
    await this.reverify(session);
    const installation = connection.installation;
    if (
      installation.id !==
      (outcome === "committed"
        ? tx.manifest.expectedNewInstallationId
        : tx.manifest.source.target.id)
    )
      throw denied();
    connection.adoption = null;
    connection.recoveryInstallationId = null;
    connection.maintenance = null;
    this.sessionsByConnection.delete(connection);
    this.publish(connection);
    return { installation, attempted: true };
  }
  async authorizeInstall(
    session: VerifiedNativeSession,
    prepared: PreparedFrame,
  ): Promise<boolean> {
    await this.reverify(session);
    await this.options.verifyService({ coverage: true });
    if (
      !prepared.transactionId ||
      prepared.reservationId !== prepared.transactionId
    )
      throw denied();
    const tx = readNativeTransaction(
      this.getCtx(),
      prepared.installationId,
      prepared.transactionId,
    );
    const {
      kind: _,
      sequence: __,
      reservationId: ___,
      journalSha256: ____,
      ...binding
    } = prepared;
    const {
      command: _____,
      candidate: ______,
      target: _______,
      ...expected
    } = tx.command;
    if (
      !sameNativeValue(binding, expected) ||
      prepared.journalSha256 !== tx.digest ||
      !sameNativeValue(tx.command.target, session.installation) ||
      tx.manifest.nativeSessionId !== session.sessionId ||
      !sameProcess(tx.manifest.oldDesktop, session.desktop) ||
      !sameProcess(tx.manifest.oldService, session.service) ||
      tx.record.requestedBy !== session.desktopClientId ||
      tx.record.requesterBootId !== session.bootId ||
      tx.manifest.oldServiceExecutable !== this.serviceExecutable
    )
      throw denied();
    if (
      session.installation.ownership === "managed" &&
      !hasReservation(this.getCtx(), prepared.transactionId)
    )
      throw denied();
    grantNativeTransaction(tx);
    return true;
  }
  async verifyOutcome(
    session: VerifiedNativeSession,
    record: UpdateRecord,
    outcome: "committed" | "restored" | "recovery-failed",
  ): Promise<{ installation: Installation; attempted: boolean }> {
    if (!record.transactionId || outcome === "recovery-failed") throw denied();
    const tx = readNativeCleanup(
      this.getCtx(),
      record.installationId,
      record.transactionId,
    );
    if (tx.journal.state !== outcome) throw denied();
    if (!tx.authorization) {
      this.verifyBundle(tx.command.target.appPath);
      await verifyInstallation(this.getCtx(), tx.command.target);
      await this.options.verifyService({ coverage: true });
      if (
        outcome !== "restored" ||
        tx.command.target.id !== session.installation.id
      )
        throw denied();
      return { installation: tx.command.target, attempted: false };
    }
    const proof =
      outcome === "committed"
        ? tx.journal.verificationProof
        : tx.journal.restorationProof;
    const connection = [...this.connections].find(
      (item) => item.ready && !item.dead && sameNativeValue(item.proof, proof),
    );
    if (!proof || !connection || !connection.installation) throw denied();
    const verified = this.sessionsByConnection.get(connection);
    if (!verified) throw denied();
    await this.reverify(verified);
    if (
      connection.installation.id !== session.installation.id ||
      connection.installation.version !==
        (outcome === "committed"
          ? record.candidate?.version
          : session.installation.version)
    )
      throw denied();
    // Outcome proof ends this launch capability. Future commands use the newly
    // verified baseline, while the private proof remains available for cleanup.
    connection.ticket = null;
    connection.maintenance = null;
    this.sessionsByConnection.delete(connection);
    this.publish(connection);
    return {
      installation: connection.installation,
      attempted: tx.authorization !== null,
    };
  }
  private publish(connection: Connection): void {
    if (!connection.installation || connection.identity.role !== "desktop")
      throw denied();
    if (!this.sessionsByConnection.has(connection))
      this.sessionsByConnection.set(connection, {
        installation: connection.recoveryInstallationId
          ? readAdoption(this.getCtx(), connection.recoveryInstallationId)!
              .authority.target
          : connection.adoption
            ? readNativeAdoption(
                this.getCtx(),
                connection.adoption.installationId,
                connection.adoption.transactionId,
              ).manifest.source.target
            : connection.ticket
              ? readNativeTransaction(
                  this.getCtx(),
                  connection.ticket.installationId,
                  connection.ticket.transactionId,
                ).command.target
              : connection.installation,
        desktopClientId: connection.clientId,
        sessionId: connection.sessionId,
        bootId: connection.identity.process.bootId,
        desktop: connection.identity.process,
        service: this.service!,
        alive: () => !connection.dead && connection.ready,
        closed: connection.peer.closed,
      });
    this.changed();
  }
  private authorized(binding: Binding) {
    if (!binding.transactionId) throw denied();
    const tx = readNativeTransaction(
      this.getCtx(),
      binding.installationId,
      binding.transactionId,
    );
    // A recover command has a new command ID/nonce; mutation remains bound to the
    // original authorization stored in this immutable transaction.
    if (
      !tx.authorization ||
      tx.record.transactionId !== binding.transactionId ||
      binding.revision > tx.record.revision
    )
      throw denied();
    if (
      tx.command.target.ownership === "managed" &&
      !hasReservation(this.getCtx(), binding.transactionId) &&
      !["committed", "restored"].includes(tx.journal.state)
    )
      throw denied();
    return tx;
  }
  private async handle(connection: Connection, value: unknown): Promise<void> {
    const frame = requestSchema.parse(value);
    if (
      frame.sessionId !== connection.sessionId ||
      frame.sequence !== connection.sequence + 1 ||
      connection.dead
    )
      throw denied();
    connection.sequence = frame.sequence;
    this.options.authority.verifyPeer(
      connection.peer.auditToken,
      connection.identity.role,
      connection.identity.process,
    );
    if (frame.kind === "heartbeat") {
      await connection.peer.send({
        schema: 1,
        kind: "alive",
        sequence: frame.sequence,
      });
      return;
    }
    if (frame.kind === "op") {
      if (connection.identity.role !== "desktop") throw denied();
      if (!connection.ready) throw denied();
      const { op, params } = frame;
      const result = await this.dispatchOp(connection, op, params);
      await connection.peer.send({
        schema: 1,
        kind: "op-result",
        sequence: frame.sequence,
        result,
      });
      return;
    }
    if (frame.kind === "snapshot") {
      if (connection.identity.role !== "desktop") throw denied();
      if (!connection.ready) throw denied();
      const snap = await this.getSnapshot(connection);
      await connection.peer.send({
        schema: 1,
        kind: "snapshot",
        sequence: frame.sequence,
        snapshot: snap,
      });
      return;
    }
    if (frame.kind === "subscribe-events") {
      if (connection.identity.role !== "desktop") throw denied();
      if (!connection.ready) throw denied();
      this.eventSubscriptions.set(connection.sessionId, connection);
      await connection.peer.send({
        schema: 1,
        kind: "subscribed",
        sequence: frame.sequence,
      });
      return;
    }
    if (frame.kind === "desktop-ready") {
      if (
        connection.identity.role !== "desktop" ||
        frame.serviceVersion !== currentVersion()
      )
        throw denied();
      if (connection.adoption) {
        const verified = verifyAdoptionLaunch(
          this.getCtx(),
          connection.adoption,
          connection.identity.process,
          this.service!,
          this.serviceExecutable,
          currentVersion(),
        );
        const expected = {
          installationId: connection.adoption.installationId,
          transactionId: connection.adoption.transactionId,
          resultingInstallationId: verified.selected.installationId,
          branch: verified.selected.branch,
          desktop: connection.identity.process,
          nativeSessionId: connection.sessionId,
          desktopVersion: connection.installation!.version,
          service: this.service,
          serviceVersion: currentVersion(),
          protocol: 3,
          desktopSignedIn: true,
          validStateRead: true,
        };
        if (frame.proof || !sameNativeValue(frame.adoptionProof, expected))
          throw denied();
        connection.adoptionProof = adoptionReadinessSchema.parse(expected);
      } else if (frame.adoptionProof) throw denied();
      else if (connection.ticket) {
        const ticket = connection.ticket,
          proof = frame.proof;
        if (
          !proof ||
          !sameProcess(proof.desktop, connection.identity.process) ||
          !sameProcess(proof.service, this.service) ||
          proof.installationId !== ticket.installationId ||
          proof.transactionId !== ticket.transactionId ||
          proof.nativeSessionId !== connection.sessionId ||
          proof.desktopVersion !== ticket.desktopVersion ||
          proof.serviceVersion !== ticket.serviceVersion
        )
          throw denied();
        verifyNativeLaunch(this.getCtx(), ticket, connection.identity.process);
        connection.proof = proof;
      } else if (frame.proof) throw denied();
      connection.ready = true;
      this.publish(connection);
      await connection.peer.send({
        schema: 1,
        kind: "ready",
        sequence: frame.sequence,
      });
      return;
    }
    if (frame.kind === "effect-ack") {
      const effect = this.pendingEffects.get(frame.effectId);
      if (!effect || effect.connection !== connection) throw denied();
      if (effect.confirmExit) await connection.peer.send({ schema: 1, kind: "effect-accepted", effectId: frame.effectId });
      this.pendingEffects.delete(frame.effectId);
      effect.resolve();
      return;
    }
    if (connection.identity.role !== "helper") throw denied();
    await this.options.verifyService();
    if (frame.kind === "fixture-cleanup") {
      const policy = compiledNativeFixture();
      if (!policy) throw denied();
      verifyNativeFixture(policy);
      if (
        realpathSync(this.getCtx().home) !== policy.home ||
        realpathSync(this.getCtx().pacerHome) !== policy.home ||
        this.options.port !== policy.port
      )
        throw denied();
      this.verifyBundle(policy.currentApp);
      const installation = await inspectInstallation(
        this.getCtx(),
        policy.currentApp,
      );
      if (
        installation.serviceLabel !== policy.serviceLabel ||
        installation.port !== policy.port
      )
        throw denied();
      const reservationId = `fixture-cleanup-${policy.nonce}`;
      const reservation = await reserveIdle(this.getCtx(), reservationId);
      if (!reservation.reserved) throw denied();
      await this.options.verifyService({ coverage: true });
      const desktops = [...this.connections].filter(
        (peer) =>
          !peer.dead &&
          peer.identity.role === "desktop" &&
          peer.installation?.appPath === policy.currentApp,
      );
      const identities = desktops.map((peer) => peer.identity.process);
      for (const desktop of desktops) {
        this.options.authority.verifyPeer(
          desktop.peer.auditToken,
          "desktop",
          desktop.identity.process,
        );
        await this.effect(desktop, "fixture-shutdown");
      }
      await connection.peer.send({
        schema: 1,
        kind: "fixture-cleanup",
        reservationId,
        installationId: installation.id,
        service: this.service,
        desktops: identities,
      });
      return;
    }
    if (frame.kind === "adoption-recovery-context") {
      if (!frame.binding.transactionId) throw denied();
      const tx = readNativeAdoption(
        this.getCtx(),
        frame.binding.installationId,
        frame.binding.transactionId,
      );
      if (
        !tx.authorization ||
        !hasReservation(this.getCtx(), frame.binding.transactionId) ||
        frame.binding.revision > tx.record.revision ||
        tx.manifest.source.bootId === this.service!.bootId ||
        this.serviceExecutable !==
          tx.manifest.source.oldServiceExecutable ||
        currentVersion() !== tx.manifest.source.serviceVersion
      )
        throw denied();
      const peers = [...this.connections].filter(
        (c) =>
          c.ready &&
          !c.dead &&
          c.identity.role === "desktop" &&
          c.installation?.appPath === tx.manifest.source.target.appPath &&
          c.installation.version === tx.manifest.source.target.version &&
          c.identity.process.bootId === this.service!.bootId,
      );
      if (peers.length > 1) throw denied();
      const desktop = peers[0];
      if (desktop)
        this.options.authority.verifyPeer(
          desktop.peer.auditToken,
          "desktop",
          desktop.identity.process,
        );
      await connection.peer.send(
        desktop
          ? {
              desktop: desktop.identity.process,
              nativeSessionId: desktop.sessionId,
              service: this.service,
              serviceExecutable: this.serviceExecutable,
              serviceVersion: currentVersion(),
              protocol: 3,
            }
          : null,
      );
      return;
    }
    if (frame.kind === "adoption-context") {
      const binding = frame.binding;
      if (!binding.transactionId) throw denied();
      let record = readAdoption(this.getCtx(), binding.installationId);
      const prepared = join(
        this.getCtx().pacerHome,
        "desktop-updates/native",
        binding.installationId,
        binding.transactionId,
        "adoption-prepared.json",
      );
      let tx: ReturnType<typeof readNativeAdoption> | null = null;
      if (existsSync(prepared)) {
        try {
          tx = readNativeAdoption(
            this.getCtx(),
            binding.installationId,
            binding.transactionId,
          );
        } catch {
          tx = readNativeAdoption(
            this.getCtx(),
            binding.installationId,
            binding.transactionId,
            true,
          );
        }
        record = tx.record;
      }
      if (
        !record ||
        record.transactionId !== binding.transactionId ||
        binding.revision > record.revision
      )
        throw denied();
      if (!tx || !["committed", "restored"].includes(tx.journal.state)) {
        if (!hasReservation(this.getCtx(), binding.transactionId))
          throw denied();
      }
      if (!tx) {
        const live = this.sessions().find(
          (s) => s.sessionId === record.authority.nativeSessionId,
        );
        if (
          !live ||
          record.phase !== "reserved" ||
          binding.revision !== record.revision
        )
          throw denied();
        await this.reverify(live);
      }
      const receipt = record.receipts.find(
        (r) =>
          r.action === "adopt" && r.transactionId === binding.transactionId,
      );
      if (!receipt) throw denied();
      await connection.peer.send({
        schema: 1,
        binding,
        transactionKind: "adoption",
        source: record.authority,
        service: this.service,
        serviceExecutable: this.serviceExecutable,
        serviceVersion: currentVersion(),
        protocol: 3,
        admissionProtocol: 1,
        stateCompatible: true,
        request: {
          requestId: receipt.requestId,
          fingerprint: receipt.fingerprint,
        },
        transaction: {
          reservationId: binding.transactionId,
          journalSha256: tx?.digest ?? null,
          authorized: !!tx?.authorization,
        },
      });
      return;
    }
    if (
      frame.kind === "adoption-reconnect" ||
      frame.kind === "adoption-observe-launch" ||
      frame.kind === "adoption-readiness" ||
      frame.kind === "adoption-release" ||
      frame.kind === "adoption-suppress" ||
      frame.kind === "adoption-shutdown"
    ) {
      await this.options.verifyService({ coverage: true });
      if (!frame.binding.transactionId) throw denied();
      const tx = readNativeAdoption(
        this.getCtx(),
        frame.binding.installationId,
        frame.binding.transactionId,
        frame.kind === "adoption-release",
      );
      if (
        frame.binding.revision > tx.record.revision ||
        (!tx.authorization && frame.kind !== "adoption-release")
      )
        throw denied();
      if (
        frame.kind !== "adoption-release" &&
        !hasReservation(this.getCtx(), frame.binding.transactionId)
      )
        throw denied();
      if (frame.kind === "adoption-reconnect") {
        if (!sameNativeValue(frame.plan, adoptionReconnectPlan(tx)))
          throw denied();
        const desktop = [...this.connections].find(
          (c) =>
            !c.dead &&
            c.sessionId === frame.plan.nativeSessionId &&
            sameProcess(c.identity.process, frame.plan.desktop),
        );
        if (!desktop) throw denied();
        await this.effect(desktop, "adoption-reconnect", undefined, frame.plan);
        desktop.maintenance = frame.binding.transactionId;
      } else if (frame.kind === "adoption-observe-launch") {
        const selected = tx.journal.steps.findLast(
            (s) =>
              s.action.kind === "launch-service" &&
              s.action.branch === frame.branch &&
              s.intentBootId === this.service!.bootId,
          ),
          executable =
            frame.branch === "managed"
              ? tx.manifest.source.newServiceExecutable
              : tx.manifest.source.oldServiceExecutable,
          version =
            frame.branch === "managed"
              ? tx.manifest.source.target.version
              : tx.manifest.source.serviceVersion;
        if (
          selected?.action.kind !== "launch-service" ||
          this.serviceExecutable !== executable ||
          currentVersion() !== version
        ) {
          await connection.peer.send(null);
          return;
        }
        if (
          selected.evidence &&
          (selected.evidence.kind !== "launched" ||
            !sameProcess(selected.evidence.launch.process, this.service))
        )
          throw denied();
        await connection.peer.send({
          role: "service",
          release: frame.branch === "managed" ? "candidate" : "old",
          launchId: selected.action.launchId,
          process: this.service,
          nativeSessionId: selected.action.launchId,
          version,
        });
        return;
      } else if (frame.kind === "adoption-readiness") {
        const found = [...this.connections].find(
          (c) =>
            c.ready &&
            !c.dead &&
            c.adoptionProof?.installationId === frame.binding.installationId &&
            c.adoptionProof.transactionId === frame.binding.transactionId &&
            c.adoptionProof.branch === frame.branch,
        );
        await connection.peer.send(found?.adoptionProof ?? null);
        return;
      } else if (frame.kind === "adoption-suppress") {
        const desktop = [...this.connections].find(
          (c) =>
            !c.dead &&
            sameProcess(
              c.identity.process,
              adoptionReconnectPlan(tx).desktop,
            ) &&
            c.maintenance === frame.binding.transactionId,
        );
        if (!desktop) throw denied();
      } else if (frame.kind === "adoption-shutdown") {
        if (
          !sameProcess(frame.expected, this.service) ||
          !this.shutdown
        )
          throw denied();
        if (!sameProcess(this.service, tx.manifest.source.service)) {
          const plan = adoptionReconnectPlan(tx);
          verifyAdoptionLaunch(
            this.getCtx(),
            plan,
            plan.desktop,
            this.service!,
            this.serviceExecutable,
            currentVersion(),
          );
        }
      } else {
        if (tx.authorization) {
          const proof =
            tx.journal.state === "committed"
              ? tx.journal.verificationProof
              : tx.journal.restorationProof;
          if (!proof) throw denied();
          const desktop = [...this.connections].find(
            (c) =>
              c.ready && !c.dead && sameNativeValue(c.adoptionProof, proof),
          );
          if (
            hasReservation(this.getCtx(), frame.binding.transactionId) &&
            !desktop
          )
            throw denied();
          if (desktop) {
            await this.effect(desktop, "resume", {
              ...frame.binding,
              installationId: desktop.installation!.id,
            });
            desktop.maintenance = null;
          }
        } else {
          this.verifyBundle(tx.manifest.source.target.appPath);
          await verifyInstallation(this.getCtx(), tx.manifest.source.target);
        }
        await releaseReservation(this.getCtx(), frame.binding.transactionId);
      }
      await connection.peer.send({
        schema: 1,
        kind: "ack",
        action: frame.kind,
        binding: frame.binding,
      });
      if (frame.kind === "adoption-shutdown") this.shutdown!();
      return;
    }
    if (frame.kind === "helper-context") {
      const binding = frame.binding;
      let session = this.sessions().find(
        (item) => item.installation.id === binding.installationId,
      );
      const record = readUpdate(this.getCtx(), binding.installationId);
      // Check/download progress and configuration advance the public revision
      // while this helper is working. This read-only context grants no install
      // authority; reverify the live native session below. Transaction requests
      // still require their exact persisted transaction and reservation.
      if (!binding.transactionId && (binding.revision > record.revision ||
          binding.revision !== record.revision && !["checking", "downloading"].includes(record.phase)))
        throw denied();
      if (binding.transactionId) {
        if (
          record.transactionId !== binding.transactionId ||
          binding.revision > record.revision
        )
          throw denied();
        const preparedPath = join(
          this.getCtx().pacerHome,
          "desktop-updates/native",
          binding.installationId,
          binding.transactionId,
          "prepared.json",
        );
        if (
          record.phase !== "reserved" ||
          !session ||
          existsSync(preparedPath)
        ) {
          let tx;
          try {
            tx = readNativeTransaction(
              this.getCtx(),
              binding.installationId,
              binding.transactionId,
            );
          } catch {
            tx = readNativeCleanup(
              this.getCtx(),
              binding.installationId,
              binding.transactionId,
            );
          }
          await connection.peer.send({
            schema: 1,
            binding,
            target: tx.command.target,
            nativeSessionId: tx.manifest.nativeSessionId,
            desktop: tx.manifest.oldDesktop,
            service: this.service,
            serviceVersion: currentVersion(),
            serviceExecutable: this.serviceExecutable,
            protocol: 3,
            admissionProtocol: 1,
            stateCompatible: true,
            transaction: {
              reservationId: binding.transactionId,
              journalSha256: tx.digest,
              authorized: tx.authorization !== null,
            },
          });
          return;
        }
        if (
          session.installation.ownership === "managed" &&
          !hasReservation(this.getCtx(), binding.transactionId)
        )
          throw denied();
      }
      if (!session) throw denied();
      await this.reverify(session);
      await connection.peer.send({
        schema: 1,
        binding,
        target: session.installation,
        nativeSessionId: session.sessionId,
        desktop: session.desktop,
        service: this.service,
        serviceVersion: currentVersion(),
        serviceExecutable: this.serviceExecutable,
        protocol: 3,
        admissionProtocol: 1,
        stateCompatible: true,
        transaction: binding.transactionId
          ? {
              reservationId: binding.transactionId,
              journalSha256: null,
              authorized: false,
            }
          : null,
      });
      return;
    }
    if (frame.kind === "query-readiness") {
      const tx = readNativeTransaction(
        this.getCtx(),
        frame.installationId,
        frame.transactionId,
      );
      if (!tx.authorization) throw denied();
      const ready = [...this.connections].find(
        (item) =>
          item.ready &&
          !item.dead &&
          item.proof?.installationId === frame.installationId &&
          item.proof.transactionId === frame.transactionId,
      );
      await connection.peer.send(ready?.proof ?? null);
      return;
    }
    const tx =
      frame.kind === "release-reservation"
        ? readNativeCleanup(
            this.getCtx(),
            frame.binding.installationId,
            frame.binding.transactionId!,
          )
        : this.authorized(frame.binding);
    if (frame.kind === "observe-launch") {
      if (
        this.serviceLaunch?.evidence.launchId === frame.launchId &&
        this.serviceLaunch.installationId === frame.binding.installationId &&
        this.serviceLaunch.transactionId === frame.binding.transactionId
      ) {
        await connection.peer.send(this.serviceLaunch.evidence);
        return;
      }
      const found = [...this.connections].find(
        (item) =>
          !item.dead &&
          item.ticket?.launchId === frame.launchId &&
          item.ticket.transactionId === frame.binding.transactionId,
      );
      const intent = tx.journal.steps.find(
        (step) =>
          step.action.kind === "launch" &&
          step.action.launchId === frame.launchId,
      );
      await connection.peer.send(
        found && intent
          ? {
              role: "desktop",
              release: intent.action.release,
              launchId: frame.launchId,
              process: found.identity.process,
              nativeSessionId: found.sessionId,
              version: found.installation!.version,
            }
          : null,
      );
      return;
    }
    const desktops = [...this.connections].filter(
      (item) =>
        !item.dead && item.installation?.id === frame.binding.installationId,
    );
    if (
      frame.kind === "suppress-lifecycle" ||
      frame.kind === "shutdown-desktop" ||
      frame.kind === "shutdown-service"
    ) {
      await this.options.verifyService({ coverage: true });
    }
    if (frame.kind === "suppress-lifecycle")
      for (const desktop of desktops) {
        await this.effect(desktop, "maintenance", frame.binding);
        desktop.maintenance = frame.binding.transactionId;
      }
    else if (frame.kind === "shutdown-desktop") {
      const desktop = desktops.find((item) =>
        sameProcess(item.identity.process, frame.expected),
      );
      if (!desktop || desktop.maintenance !== frame.binding.transactionId)
        throw denied();
      await this.effect(desktop, "shutdown", frame.binding);
    } else if (frame.kind === "shutdown-service") {
      if (
        tx.command.target.ownership !== "managed" ||
        !sameProcess(frame.expected, this.service) ||
        !this.shutdown
      )
        throw denied();
    } else if (frame.kind === "release-reservation") {
      if (frame.binding.revision > tx.record.revision) throw denied();
      if (!tx.authorization) {
        this.verifyBundle(tx.command.target.appPath);
        await verifyInstallation(this.getCtx(), tx.command.target);
      } else {
        const proof =
          tx.journal.state === "committed"
            ? tx.journal.verificationProof
            : tx.journal.restorationProof;
        if (!proof) throw denied();
        if (
          hasReservation(this.getCtx(), frame.binding.transactionId!) &&
          ![...this.connections].some(
            (item) =>
              item.ready && !item.dead && sameNativeValue(item.proof, proof),
          )
        )
          throw denied();
        for (const desktop of desktops.filter(
          (item) => item.maintenance === frame.binding.transactionId,
        )) {
          await this.effect(desktop, "resume", frame.binding);
          desktop.maintenance = null;
        }
      }
      if (tx.command.target.ownership === "managed")
        await releaseReservation(this.getCtx(), frame.binding.transactionId!);
    }
    await connection.peer.send({
      schema: 1,
      kind: "ack",
      action: frame.kind,
      binding: frame.binding,
    });
    if (frame.kind === "shutdown-service") this.shutdown!();
  }
  private async effect(
    connection: Connection,
    kind:
      | "maintenance"
      | "shutdown"
      | "resume"
      | "fixture-shutdown"
      | "adoption-reconnect",
    binding?: Binding,
    plan?: AdoptionReconnectPlan,
  ): Promise<void> {
    const effectId = randomUUID();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const ack = new Promise<void>((resolve, reject) => {
      this.pendingEffects.set(effectId, {
        connection,
        confirmExit: kind === "shutdown" || kind === "fixture-shutdown" || kind === "adoption-reconnect" && plan?.recovery === true,
        resolve,
        reject: () => reject(denied()),
      });
      timeout = setTimeout(() => {
        this.pendingEffects.delete(effectId);
        reject(denied());
      }, 10_000);
      timeout.unref();
    });
    try {
      await connection.peer.send({
        schema: 1,
        kind,
        effectId,
        ...(binding ? { binding } : {}),
        ...(plan ? { plan } : {}),
      });
      await ack;
    } finally {
      clearTimeout(timeout);
      this.pendingEffects.delete(effectId);
    }
  }
  private async dispatchOp(connection: Connection, op: string, params: unknown): Promise<unknown> {
    const ctx = this.getCtx();
    const { callOp } = await import("../../api/ops");
    return callOp(ctx, op, params, { desktopUpdates: this as any });
  }
  private async getSnapshot(connection: Connection): Promise<unknown> {
    const ctx = this.getCtx();
    const { liveSnapshot } = await import("../../api/events");
    return liveSnapshot(ctx);
  }
  /** Push an event to all subscribed desktop connections over native frames. */
  async broadcastEvent(eventType: string, data: unknown): Promise<void> {
    let seq = 0;
    for (const [, conn] of this.eventSubscriptions) {
      if (conn.dead || !conn.ready) continue;
      seq++;
      await conn.peer.send({
        schema: 1,
        kind: "event",
        event: eventType,
        data,
        id: seq,
      });
    }
  }
}

/** Read only the fixed sealed metadata file, with bounded non-following IO. */
function nativeServiceMetadata(app: string): string {
  const path = join(app, BUNDLE_RELEASE_PATH);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.()
      || before.mode & 0o022 || before.size > 65536) throw denied();
    const buffer = Buffer.alloc(65537);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    const after = fstatSync(fd), linked = lstatSync(path);
    if (size > 65536 || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || linked.dev !== after.dev || linked.ino !== after.ino || linked.isSymbolicLink()) throw denied();
    return buffer.subarray(0, size).toString("utf8");
  } finally { closeSync(fd); }
}

/** A paired core requires the authenticated private parent bootstrap. */
export function assertLegacyNativeServiceLayout(executable: string): void {
  if (basename(executable) === "pacer-core") throw denied();
  const resources = dirname(executable), contents = dirname(resources), app = dirname(contents);
  if (basename(resources) === "Resources" && basename(contents) === "Contents" && app.endsWith(".app")
    && parseBundleRelease(JSON.parse(nativeServiceMetadata(app))).cliLayout === "paired") throw denied();
}

/** Internal revalidation of an already authenticated paired bootstrap. */
export function verifyPairedNativeServiceOwner(
  authority: Pick<DarwinAuthority, "verifyProcess" | "verifyStatic">,
  owner: NativeServiceOwner,
  port: number,
  metadata: string,
): NativeProcess {
  const own = ownProcessIdentity(), uid = process.getuid?.();
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !own || uid === undefined || !sameProcess(owner.transport, own)
    || owner.process.pid !== process.ppid || sameProcess(owner.process, own)) throw denied();
  const front = authority.verifyProcess(owner.process, "cli");
  const core = authority.verifyProcess(own, "cli");
  const frontPath = join(owner.appPath, BUNDLED_CLI_PATH), corePath = join(owner.appPath, BUNDLED_CORE_PATH);
  if (!sameProcess(front.process, owner.process) || !sameProcess(core.process, own)
    || front.uid !== uid || core.uid !== uid || core.parentPid !== front.process.pid
    || owner.executable !== frontPath || front.executable !== frontPath || core.executable !== corePath
    || realpathSync(owner.appPath) !== owner.appPath || realpathSync(frontPath) !== frontPath
    || realpathSync(corePath) !== corePath || owner.argv[0] !== frontPath || owner.argv[1] !== "serve"
    || !(owner.argv.length === 2 || owner.argv.length === 4 && owner.argv[2] === "--port" && (owner.argv[3] === String(port) || owner.argv[3] === "0"))) throw denied();
  authority.verifyStatic(owner.appPath, "desktop");
  authority.verifyStatic(frontPath, "cli");
  authority.verifyStatic(corePath, "cli");
  const actual = nativeServiceMetadata(owner.appPath);
  if (actual !== metadata) throw denied();
  const release = parseBundleRelease(JSON.parse(actual));
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : null;
  if (!arch || release.cliLayout !== "paired" || release.version !== currentVersion()
    || release.arch !== arch || !release.protocolMajors.includes(3)) throw denied();
  return core;
}

/** launchd owns the logical service, which is the Root in paired mode. */
export function assertNativeServiceLaunch(
  owner: Pick<NativeServiceOwner, "process" | "executable" | "argv">,
  registeredArgv: readonly string[],
  status: { code: number; stdout: string },
): void {
  if (!registeredArgv[0] || realpathSync(registeredArgv[0]) !== owner.executable
    || !sameNativeValue(owner.argv, registeredArgv) || status.code !== 0
    || !new RegExp(`\\n\\s*pid = ${owner.process.pid}\\s*\\n`).test(status.stdout)) throw denied();
}

export function configuredNativeBridge(
  getCtx: () => Ctx,
  port: number,
  shutdown?: () => void,
  paired?: PairedNativeBootstrap,
): NativeControlBridge | null {
  const authority = DarwinAuthority.configured();
  if (!authority) {
    if (paired) throw denied();
    return null;
  }
  const service = paired?.owner.process ?? ownProcessIdentity();
  if (!service) throw denied();
  const executable = paired?.owner.executable ?? realpathSync(process.execPath);
  if (!paired) assertLegacyNativeServiceLayout(executable);
  const metadata = paired ? nativeServiceMetadata(paired.owner.appPath) : null;
  const verifyService = async (options?: { coverage?: boolean }) => {
    const ctx = getCtx(),
      registration = parseDesktopServiceRegistration(
        readFileSync(servicePath(ctx, "darwin"), "utf8"),
        desktopServiceLabel(ctx),
      );
    if (
      realpathSync(registration.argv[0]!) !== executable ||
      realpathSync(registration.home) !== realpathSync(ctx.home) ||
      realpathSync(registration.pacerHome) !== realpathSync(ctx.pacerHome) ||
      registration.port !== port
    ) throw denied();
    const allowed: ProcessIdentity[] = [];
    if (paired) {
      const core = verifyPairedNativeServiceOwner(authority, paired.owner, port, metadata!);
      allowed.push(core.process);
    } else {
      authority.verifyStatic(process.execPath, "cli");
      authority.verifyProcess(service, "cli");
    }
    const fixture = compiledNativeFixture();
    if (fixture) verifyNativeFixture(fixture);
    const processes = enumerateNativeProcesses().filter(
      (process) => !fixture || fixtureProcessInScope(fixture, process.executable),
    );
    for (const process of processes) {
      const role = process.executable?.endsWith(".app/Contents/MacOS/pacer")
        ? "desktop"
        : basename(process.executable ?? "") === "pacer-update-helper" ? "helper" : null;
      if (role) {
        authority.verifyProcess(process.process, role);
        allowed.push(process.process);
      }
    }
    if (options?.coverage) {
      assertNativeProcessCoverage(processes, service, enrolledWorkProcesses(ctx), executable, allowed);
    }
    const status = await ctx.run(
      ["/bin/launchctl", "print", `gui/${process.getuid!()}/${registration.label}`], 5000,
    );
    assertNativeServiceLaunch(
      { process: service, executable, argv: paired?.owner.argv ?? nativeServiceArgv() },
      registration.argv,
      status,
    );
    // The launchctl await must not allow a replaced/dead parent incarnation.
    if (paired) verifyPairedNativeServiceOwner(authority, paired.owner, port, metadata!);
  };
  return new NativeControlBridge(getCtx, { port, authority, verifyService, shutdown, paired });
}

/** Roles used when deciding whether a known pacer process blocks an install. */
export type NativeCoverageRole = "service" | "lease" | "verified" | "cli" | "foreign";

const PACER_NAME = /(^|[-_.])pacer($|[-_.])/;
let lastCoverageLogAt = 0;

function looksLikePacerProcess(process: NativeProcess, registeredExecutable: string): boolean {
  const name = process.executable ? basename(process.executable) : process.name;
  return (
    process.executable === registeredExecutable ||
    PACER_NAME.test(name) ||
    process.name === "pacer"
  );
}

/**
 * Members of the process trees rooted at the given identities.
 * A root counts only when its exact incarnation is present in the table.
 * Dead or unmatched roots never become parentPid anchors (PID reuse must not
 * cover a foreign child under a recycled enrolled/service pid).
 */
export function nativeProcessTreePids(
  roots: readonly ProcessIdentity[],
  processes: readonly NativeProcess[],
): Set<number> {
  const covered = new Set<number>();
  for (const root of roots) {
    const match = processes.find((process) => sameProcess(process.process, root));
    if (match) covered.add(match.process.pid);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const process of processes) {
      if (covered.has(process.process.pid)) continue;
      if (covered.has(process.parentPid)) {
        covered.add(process.process.pid);
        grew = true;
      }
    }
  }
  return covered;
}

/**
 * Classify every same-UID pacer-named process for install coverage.
 * Service and lease trees are covered. Same-path CLI clients (msg inbox, status,
 * hooks) do not refuse install forever: reserveIdle drains enrolled leases, and
 * short-lived CLI work is not an install blocker. A foreign path still blocks.
 * Running macOS processes keep their old inode after a bundle replace; they are
 * not restarted by the replace itself.
 */
export function classifyNativeProcessCoverage(
  processes: readonly NativeProcess[],
  service: ProcessIdentity,
  enrolled: readonly ProcessIdentity[],
  registeredExecutable: string,
  verifiedNative: readonly ProcessIdentity[] = [],
): { process: NativeProcess; role: NativeCoverageRole }[] {
  const serviceTree = nativeProcessTreePids([service], processes);
  const leaseTree = nativeProcessTreePids(enrolled, processes);
  const decisions: { process: NativeProcess; role: NativeCoverageRole }[] = [];
  for (const process of processes) {
    if (!looksLikePacerProcess(process, registeredExecutable)) continue;
    if (sameProcess(process.process, service) || serviceTree.has(process.process.pid)) {
      decisions.push({ process, role: "service" });
      continue;
    }
    if (
      enrolled.some((identity) => sameProcess(identity, process.process)) ||
      leaseTree.has(process.process.pid)
    ) {
      decisions.push({ process, role: "lease" });
      continue;
    }
    if (verifiedNative.some((identity) => sameProcess(identity, process.process))) {
      decisions.push({ process, role: "verified" });
      continue;
    }
    // Same registered front door, or a sibling under the paired Resources dir
    // (pacer-core / short-lived CLI clients). Delegated `_run` / `_session` work
    // is enrolled as leases and drained by reserveIdle; these CLI clients are
    // not that work and must not refuse install forever. A different install
    // path stays foreign.
    if (
      process.executable === registeredExecutable ||
      (process.executable !== null &&
        dirname(process.executable) === dirname(registeredExecutable))
    ) {
      decisions.push({ process, role: "cli" });
      continue;
    }
    decisions.push({ process, role: "foreign" });
  }
  return decisions;
}

function logCoverageDecision(decisions: readonly { role: NativeCoverageRole }[]): void {
  const now = Date.now();
  if (now - lastCoverageLogAt < 30_000) return;
  lastCoverageLogAt = now;
  const counts: Record<NativeCoverageRole, number> = {
    service: 0,
    lease: 0,
    verified: 0,
    cli: 0,
    foreign: 0,
  };
  for (const decision of decisions) counts[decision.role]++;
  const summary = (Object.keys(counts) as NativeCoverageRole[])
    .filter((role) => counts[role] > 0)
    .map((role) => `${role}=${counts[role]}`)
    .join(" ");
  console.info(`pacer: desktop update coverage ${summary || "none"}`);
}

/**
 * Install-time coverage only. Connecting and read-only native ops never call this.
 * Foreign-path pacer binaries still refuse; service/lease trees and same-path CLI clients do not.
 */
export function assertNativeProcessCoverage(
  processes: readonly NativeProcess[],
  service: ProcessIdentity,
  enrolled: readonly ProcessIdentity[],
  registeredExecutable: string,
  verifiedNative: readonly ProcessIdentity[] = [],
): void {
  const decisions = classifyNativeProcessCoverage(
    processes,
    service,
    enrolled,
    registeredExecutable,
    verifiedNative,
  );
  logCoverageDecision(decisions);
  if (decisions.some((decision) => decision.role === "foreign")) {
    throw new CoreError(
      "not_allowed",
      "Another pacer CLI process prevents desktop update",
      "Close or upgrade the other CLI process, then retry the update.",
    );
  }
}

/** Called only after native bundle trust verification; metadata alone grants no authority. */
export async function nativeHelperIdentity(ctx: Ctx, original: Installation) {
  const current = await inspectInstallation(ctx, original.appPath);
  const { version: _oldVersion, ...oldIdentity } = original;
  const { version, ...currentIdentity } = current;
  if (!sameNativeValue(oldIdentity, currentIdentity)) throw denied();
  return { version, bundleId: current.bundleId, arch: current.arch };
}

/** Recovery retains the updater key pinned into the originally authorized helper. */
export function nativeRecoveryHelper(
  ctx: Ctx,
  installationId: string,
  transactionId: string,
  kind: "update" | "adoption" = "update",
) {
  let tx;
  if (kind === "adoption") {
    try {
      tx = readNativeAdoption(ctx, installationId, transactionId);
    } catch {
      tx = readNativeAdoption(ctx, installationId, transactionId, true);
    }
  } else {
    try {
      tx = readNativeTransaction(ctx, installationId, transactionId);
    } catch {
      tx = readNativeCleanup(ctx, installationId, transactionId);
    }
  }
  const asset = z
    .object({ relativePath: z.literal("pacer-update-helper"), sha256: hash })
    .strict()
    .parse(
      z.object({ helper: z.unknown() }).parse(tx.manifest.recoveryJob).helper,
    );
  const source = join(tx.dir, asset.relativePath);
  const fd = openSync(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077 ||
      !(stat.mode & 0o100) ||
      stat.size > 128 * 1024 * 1024
    )
      throw denied();
    const digest = createHash("sha256"),
      buffer = Buffer.alloc(65536);
    let size = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      size += count;
      if (size > 128 * 1024 * 1024) throw denied();
      digest.update(buffer.subarray(0, count));
    }
    if (digest.digest("hex") !== asset.sha256) throw denied();
  } finally {
    closeSync(fd);
  }
  return {
    source,
    identity: {
      version: tx.command.target.version,
      bundleId: tx.command.target.bundleId,
      arch: tx.command.target.arch,
    },
  };
}

/** The node:fs operations used while staging a helper under PACER_HOME. Production
 *  uses the real module; tests override one operation to simulate a deterministic
 *  disk/permission failure (Linux CI runs as root, so chmod-based fixtures are unreliable). */
export type NativeStageFs = Pick<typeof import("node:fs"),
  "realpathSync" | "mkdirSync" | "lstatSync" | "copyFileSync" | "chmodSync" |
  "openSync" | "fsyncSync" | "closeSync" | "fstatSync" | "readSync" | "rmSync">;

/** Acquire only a copied, independently verified helper from a live native bundle. */
export function createNativePipeFactory(
  getCtx: () => Ctx,
  native: Pick<NativeAuthorityProvider, "sessions" | "reverify">,
  authority: DarwinAuthority,
  owner?: NativeServiceOwner,
  parentHelpers?: Pick<ParentHelperSpawner, "spawn">,
  stageFs?: Partial<NativeStageFs>,
): VerifiedPipeFactory {
  const fsOps: NativeStageFs = {
    realpathSync: stageFs?.realpathSync ?? realpathSync,
    mkdirSync: stageFs?.mkdirSync ?? mkdirSync,
    lstatSync: stageFs?.lstatSync ?? lstatSync,
    copyFileSync: stageFs?.copyFileSync ?? copyFileSync,
    chmodSync: stageFs?.chmodSync ?? chmodSync,
    openSync: stageFs?.openSync ?? openSync,
    fsyncSync: stageFs?.fsyncSync ?? fsyncSync,
    closeSync: stageFs?.closeSync ?? closeSync,
    fstatSync: stageFs?.fstatSync ?? fstatSync,
    readSync: stageFs?.readSync ?? readSync,
    rmSync: stageFs?.rmSync ?? rmSync,
  };
  return {
    capabilities: new Set(["check", "download", "install", "recover", "adopt", "recover-adoption"]),
    async open(installationId, signal) {
      const session = native
        .sessions()
        .find(
          (session) =>
            session.installation.id === installationId && session.alive(),
        );
      if (!session || signal.aborted) throw denied();
      await native.reverify(session);
      if (signal.aborted || !session.alive()) throw denied();
      const ctx = getCtx(),
        record = readUpdate(ctx, installationId);
      const pending = [
        "reserved",
        "installing",
        "verifying",
        "rolling-back",
        "recovery-failed",
      ].includes(record.phase);
      const preparation =
        record.transactionId &&
        join(
          ctx.pacerHome,
          "desktop-updates/native",
          installationId,
          record.transactionId,
          "prepared.json",
        );
      const adopted = readAdoption(ctx, installationId),
        adoptionPreparation =
          adopted &&
          join(
            ctx.pacerHome,
            "desktop-updates/native",
            installationId,
            adopted.transactionId,
            "adoption-prepared.json",
          );
      const recovery =
        adopted &&
        adoptionPending(adopted) &&
        (adopted.phase !== "reserved" || existsSync(adoptionPreparation!))
          ? nativeRecoveryHelper(
              ctx,
              installationId,
              adopted.transactionId,
              "adoption",
            )
          : pending &&
              record.transactionId &&
              (record.phase !== "reserved" ||
                (preparation && existsSync(preparation)))
            ? nativeRecoveryHelper(ctx, installationId, record.transactionId)
            : null;
      // Check launch capability before staging anything: no command directory
      // or helper copy is created when Root cannot hand off a helper.
      if (owner && (!parentHelpers || signal.aborted)) throw helperRefused();
      // Environmental errno from staging under PACER_HOME is a storage failure,
      // never a damaged helper or a transient check. Keep the fail-closed behaviour:
      // every path below throws before a helper is spawned or a frame is written.
      const storageErrnos = new Set(["ENOSPC", "EDQUOT", "EROFS", "EACCES", "EPERM", "EIO"]);
      const storageFailure = (error: unknown, message: string) => {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        return code && storageErrnos.has(code) ? new NativeHelperStorageError(message, error) : undefined;
      };
      const stageWrite = <T>(operation: () => T, message: string): T => {
        try { return operation(); }
        catch (error) { throw storageFailure(error, message) ?? error; }
      };
      let directory = fsOps.realpathSync(ctx.pacerHome);
      const parts = recovery
        ? []
        : ["desktop-updates", "native", installationId, "commands", randomUUID()];
      // Set the command path before any mkdir: a failure partway through staging
      // (including an lstat refusal) can then clear its own directory best effort.
      let staged: string | undefined = recovery
        ? undefined
        : parts.reduce((path, part) => join(path, part), directory);
      let helperIdentity!: VerifiedPipe["identity"];
      let source!: string;
      let helper!: string;
      const cleanupStaged = () => {
        if (!staged) return;
        try { fsOps.rmSync(staged, { recursive: true, force: true }); } catch { /* best effort */ }
      };
      try {
        for (const part of parts) {
          directory = join(directory, part);
          try {
            fsOps.mkdirSync(directory, { mode: 0o700 });
          } catch (error) {
            const storage = storageFailure(error, "Desktop update helper staging directory could not be created");
            if (storage) throw storage;
            if ((error as NodeJS.ErrnoException).code !== "EEXIST")
              throw new NativeHelperIntegrityError("Desktop update helper staging directory could not be created", error);
          }
          const stat = fsOps.lstatSync(directory);
          if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            stat.uid !== process.getuid?.() ||
            stat.mode & 0o077 ||
            fsOps.realpathSync(directory) !== directory
          )
            throw new NativeHelperDataFolderError();
        }
        helperIdentity = recovery?.identity ?? (await nativeHelperIdentity(ctx, session.installation));
        source = recovery?.source ?? join(session.installation.appPath, BUNDLED_HELPER_PATH);
        helper = recovery?.source ?? join(directory, "pacer-update-helper");
        helperIntegrityCheck(() => authority.verifyStatic(source, "helper"));
        if (!recovery) {
          stageWrite(() => fsOps.copyFileSync(source, helper, constants.COPYFILE_EXCL), "Desktop update helper could not be copied into pacer's data folder");
          stageWrite(() => fsOps.chmodSync(helper, 0o700), "Desktop update helper permissions could not be set");
        }
        helperIntegrityCheck(() => authority.verifyStatic(helper, "helper"));
        const fd = stageWrite(() => fsOps.openSync(helper, constants.O_RDONLY | constants.O_NOFOLLOW), "Desktop update helper could not be opened");
        try {
          stageWrite(() => fsOps.fsyncSync(fd), "Desktop update helper could not be written to disk");
        } finally {
          fsOps.closeSync(fd);
        }
      } catch (error) {
        // A failed staging attempt must not leave a commands/<uuid> directory behind,
        // especially when the disk is full and retries would accumulate one per attempt.
        cleanupStaged();
        throw error;
      }
      if (owner) {
        // Immutable bridge helpers require the logical service to be their real
        // kernel parent. The authenticated Root supplies the fixed bootstrap.
        if (signal.aborted) {
          if (staged) fsOps.rmSync(staged, { recursive: true, force: true });
          throw helperRefused();
        }
        const hashFd = openSync(helper, constants.O_RDONLY | constants.O_NOFOLLOW);
        let sha256: string;
        try {
          const stat = fstatSync(hashFd);
          if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 128 * 1024 * 1024) throw new NativeHelperIntegrityError("Desktop update helper file failed integrity verification");
          const hash = createHash("sha256"), buffer = Buffer.alloc(65536);
          let bytes = 0;
          for (;;) {
            const count = readSync(hashFd, buffer, 0, buffer.length, null);
            if (!count) break;
            bytes += count;
            if (bytes > 128 * 1024 * 1024) throw new NativeHelperIntegrityError("Desktop update helper file failed integrity verification");
            hash.update(buffer.subarray(0, count));
          }
          sha256 = hash.digest("hex");
        } finally { closeSync(hashFd); }
        // Defence in depth for the narrowing above: the early capability check
        // already refuses, but never spawn without a channel even if it changes.
        if (!parentHelpers) {
          if (staged) fsOps.rmSync(staged, { recursive: true, force: true });
          throw helperRefused();
        }
        let child: ReturnType<ParentHelperSpawner["spawn"]>;
        try {
          child = parentHelpers.spawn({ schema: 1, path: helper, sha256, version: helperIdentity.version });
        } catch (error) {
          // No helper was accepted: clear the staged image on any spawn error,
          // including a retired channel after rights were handed over. Its pipes
          // are closed and recovery helpers are never staged, so no live helper
          // needs this copy and a later check cannot trip over the directory.
          if (staged) fsOps.rmSync(staged, { recursive: true, force: true });
          throw error;
        }
        let accepted = false;
        const abort = () => { if (!accepted) child.abort(); };
        signal.addEventListener("abort", abort, { once: true });
        try {
          const identity = processIdentity(child.pid);
          if (!identity) throw denied();
          const verified = helperIntegrityCheck(() => authority.verifyProcess(identity, "helper"));
          if (!sameProcess(verified.process, identity) || verified.executable !== helper || verified.parentPid !== owner.process.pid || signal.aborted) throw denied();
          if (!recovery) {
            const cleanup = freshHelperCleanup(helper, identity);
            void child.exited.then(cleanup, cleanup);
          }
          accepted = true;
          return { identity: helperIdentity, stdin: child.stdin, stdout: child.stdout, exited: child.exited, abort: () => child.abort() };
        } catch (error) {
          abort();
          throw denyUnlessIntegrity(error);
        } finally { signal.removeEventListener("abort", abort); }
      }
      const child = Bun.spawn([helper, "--ota-pipe"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
        env: {
          HOME: getCtx().home,
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          PACER_HOME: getCtx().pacerHome,
        },
      });
      const identity = processIdentity(child.pid);
      let handed = false;
      const abort = () => {
        if (
          !handed &&
          identity &&
          sameProcess(identity, processIdentity(child.pid))
        )
          child.kill("SIGTERM");
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (!identity) throw denied();
        const verified = helperIntegrityCheck(() => authority.verifyProcess(identity, "helper"));
        if (
          verified.executable !== helper ||
          verified.parentPid !== process.pid ||
          signal.aborted
        )
          throw denied();
        if (!recovery) {
          const cleanup = freshHelperCleanup(helper, identity);
          void child.exited.then(cleanup, () => {});
        }
        const bootstrap = encodeFrame({
          schema: 1,
          kind: "helper-bootstrap",
          home: realpathSync(getCtx().pacerHome),
          port: session.installation.port,
          service: ownProcessIdentity(),
          executable: realpathSync(process.execPath),
        });
        child.stdin.write(bootstrap);
        await child.stdin.flush();
        if (signal.aborted) throw denied();
        signal.removeEventListener("abort", abort);
        handed = true;
        return {
          identity: helperIdentity,
          stdin: new WritableStream<Uint8Array>({
            write: async (bytes) => {
              child.stdin.write(bytes);
              await child.stdin.flush();
            },
            close: () => {
              child.stdin.end();
            },
            abort: () => {
              child.stdin.end();
            },
          }),
          stdout: child.stdout,
          exited: child.exited,
          abort: () => {
            if (identity && sameProcess(identity, processIdentity(child.pid)))
              child.kill("SIGTERM");
          },
        };
      } catch (error) {
        abort();
        throw denyUnlessIntegrity(error);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}

export function configuredNativeServices(
  getCtx: () => Ctx,
  port: number,
  shutdown: () => void,
  paired?: PairedNativeBootstrap,
) {
  const native = configuredNativeBridge(getCtx, port, shutdown, paired);
  if (!native) return null;
  const authority = DarwinAuthority.configured();
  if (!authority) throw denied();
  return {
    native,
    adapter: createNativePipeFactory(getCtx, native, authority, paired?.owner, paired?.helpers),
  };
}
