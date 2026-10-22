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
  /** Internal system adapter. Never accepted from an API or environment. */
  verifyService: () => Promise<void>;
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
          if (dead) throw denied();
          if (!connection) {
            const hello = helloSchema.parse(frame);
            if (hello.challenge !== challenge) throw denied();
            const identity = this.options.authority.verifyPeer(
              peer.auditToken,
              hello.role,
            );
            await this.options.verifyService();
            let installation: Installation | null = null;
            let adoptionSession: string | undefined,
              recoveryInstallationId: string | null = null;
            if (hello.ticket && hello.adoption) throw denied();
            if (hello.role === "desktop") {
              if (!identity.executable.endsWith(".app/Contents/MacOS/pacer"))
                throw denied();
              const app = dirname(dirname(dirname(identity.executable)));
              this.verifyBundle(app);
              installation = await inspectInstallation(this.getCtx(), app);
              if (hello.version !== installation.version) throw denied();
              if (!hello.ticket && !hello.adoption) {
                const pending = listAdoptions(this.getCtx()).filter(
                  (r) =>
                    adoptionPending(r) &&
                    r.authority.target.appPath === installation!.appPath &&
                    r.authority.bootId !== identity.process.bootId,
                );
                if (pending.length > 1) throw denied();
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
                    throw denied();
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
                    if (original[key] !== installation[key]) throw denied();
                  recoveryInstallationId = original.id;
                }
              }
              if (hello.adoption) {
                const verified = verifyAdoptionLaunch(
                  this.getCtx(),
                  hello.adoption,
                  identity.process,
                  this.service!,
                  this.serviceExecutable,
                  currentVersion(),
                );
                if (installation.id !== verified.selected.installationId)
                  throw denied();
                adoptionSession = verified.selected.launchId;
              }
              if (hello.ticket) {
                verifyNativeLaunch(
                  this.getCtx(),
                  hello.ticket,
                  identity.process,
                );
                if (!sameProcess(hello.ticket.service, this.service))
                  throw denied();
              }
            } else if (hello.ticket || hello.adoption) throw denied();
            this.options.authority.verifyPeer(
              peer.auditToken,
              hello.role,
              identity.process,
            );
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
            if (dead) throw denied();
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
        .catch(() => peer.close())
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
      await this.options.verifyService();
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
      await this.options.verifyService();
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
  const verifyService = async () => {
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
    assertNativeProcessCoverage(processes, service, enrolledWorkProcesses(ctx), executable, allowed);
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

/** Conservative known-CLI coverage; arbitrary renamed legacy executables are not identifiable. */
export function assertNativeProcessCoverage(
  processes: readonly NativeProcess[],
  service: ProcessIdentity,
  enrolled: readonly ProcessIdentity[],
  registeredExecutable: string,
  verifiedNative: readonly ProcessIdentity[] = [],
): void {
  for (const process of processes) {
    if (
      sameProcess(process.process, service) ||
      enrolled.some((identity) => sameProcess(identity, process.process)) ||
      verifiedNative.some((identity) => sameProcess(identity, process.process))
    )
      continue;
    const name = process.executable
      ? basename(process.executable)
      : process.name;
    if (
      process.executable === registeredExecutable ||
      /(^|[-_.])pacer($|[-_.])/.test(name) ||
      process.name === "pacer"
    )
      throw new CoreError(
        "not_allowed",
        "Another pacer CLI process prevents desktop update",
        "Close or upgrade the other CLI process, then reconnect the desktop.",
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

/** Acquire only a copied, independently verified helper from a live native bundle. */
export function createNativePipeFactory(
  getCtx: () => Ctx,
  native: Pick<NativeAuthorityProvider, "sessions" | "reverify">,
  authority: DarwinAuthority,
  owner?: NativeServiceOwner,
): VerifiedPipeFactory {
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
      let directory = realpathSync(ctx.pacerHome);
      for (const part of recovery
        ? []
        : [
            "desktop-updates",
            "native",
            installationId,
            "commands",
            randomUUID(),
          ]) {
        directory = join(directory, part);
        try {
          mkdirSync(directory, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST")
            throw denied();
        }
        const stat = lstatSync(directory);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          stat.uid !== process.getuid?.() ||
          stat.mode & 0o077 ||
          realpathSync(directory) !== directory
        )
          throw denied();
      }
      const helperIdentity =
        recovery?.identity ??
        (await nativeHelperIdentity(ctx, session.installation));
      const source =
          recovery?.source ??
          join(session.installation.appPath, BUNDLED_HELPER_PATH),
        helper = recovery?.source ?? join(directory, "pacer-update-helper");
      authority.verifyStatic(source, "helper");
      if (!recovery) {
        copyFileSync(source, helper, constants.COPYFILE_EXCL);
        chmodSync(helper, 0o700);
      }
      authority.verifyStatic(helper, "helper");
      const fd = openSync(helper, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
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
        const verified = authority.verifyProcess(identity, "helper");
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
          service: owner?.process ?? ownProcessIdentity(),
          executable: owner?.executable ?? realpathSync(process.execPath),
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
      } catch {
        abort();
        throw denied();
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
    adapter: createNativePipeFactory(getCtx, native, authority, paired?.owner),
  };
}
