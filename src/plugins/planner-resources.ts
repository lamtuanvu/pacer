import { plannerPrivatePath } from "./planner-private-paths";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { lstatSync, realpathSync, statSync, type Stats } from "node:fs";
import { answerFilesystem, prepareFilesystemAuthority } from "./capability-fs";
import { declaredPath, absolutePath } from "./capability-paths";
import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import { createCallAuthority, type CallAuthority } from "./authority";
import {
  answerSpawn,
  prepareSpawnAuthority,
  readSpawnOutput,
  discardSpawnOutput,
} from "./capability-spawn";
import { plannerCommandIntent } from "./planner-protocol";

export interface PlannerSelection {
  purpose: "install" | "reconcile" | "uninstall" | "preview";
  binaries: readonly string[];
  pacerArgv?: readonly string[];
  /** Trusted host-only extension for an exact integration command. */
  commandApproval?: (argv: readonly string[]) => boolean;
  cwd: string;
  env?: Record<string, string>;
  roots?: readonly string[];
  files?: readonly string[];
  deadlineMs?: number;
  operationDeadlineMs?: number;
}
interface Binary {
  selected: string | null;
  canonical?: string;
  stat?: Stats;
  link?: Stats;
}
const borrows = new WeakMap<CallAuthority, PlannerResources>();
const deny = (message: string): never => {
  throw new CoreError("capability_denied", message);
};
const same = (a: Stats, b: Stats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.mode === b.mode;

/** Only host-owned Claude MCP registration may invoke a planner binary. */
function allowedPlannerCommand(scope: string, argv: readonly string[], pacerArgv: readonly string[] = []): boolean {
  if (scope !== "claude") return false;
  const args = argv.slice(1);
  if (JSON.stringify(args) === JSON.stringify(["mcp", "get", "pacer"])) return true;
  if (JSON.stringify(args) === JSON.stringify(["mcp", "remove", "-s", "user", "pacer"])) return true;
  return JSON.stringify(args) === JSON.stringify(["mcp", "add", "-s", "user", "pacer", "--", ...pacerArgv, "mcp"]);
}

function plannerEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const allowed = ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "OPENCODE_CONFIG_DIR"];
  return Object.fromEntries(allowed.flatMap(key => typeof env[key] === "string" ? [[key, env[key]]] : []));
}

/** Host-only owner. Peer admission never revokes the retained compensation pins. */
export class PlannerResources {
  private readonly context: Ctx;
  private readonly settlementDeadline: number;
  readonly operationDeadline: number;
  private readonly cleanupBudget: number;
  private reservedUndoMs = 0;
  private readonly selection: PlannerSelection;
  private readonly commandApproval?: PlannerSelection["commandApproval"];
  private readonly binaries = new Map<string, Binary>();
  private readonly observedDirectories = new Map<
    string,
    { canonical: string; stat: Stats }
  >();
  private readonly fileRoots: {
    logical: string;
    canonical: string;
    stat: Stats;
  }[] = [];
  private readonly owners = new Set<CallAuthority>();
  private readonly undos: {
    owner: CallAuthority;
    scope: string;
    params: Record<string, unknown>;
    argv: string[];
  }[] = [];
  private active?: CallAuthority;
  private output?: CallAuthority;
  private peer?: CallAuthority;
  private closed = false;
  private count = 0;
  private bytes = 0;
  private prior?: { handle: string; bytes: Buffer };
  private rollbackWork?: Promise<void>;
  constructor(ctx: Ctx, selection: PlannerSelection) {
    const admittedAt = Date.now();
    this.commandApproval = selection.commandApproval;
    this.selection = structuredClone({...selection, commandApproval: undefined});
    this.settlementDeadline = selection.deadlineMs ?? admittedAt + 600000;
    if (
      !Number.isFinite(this.settlementDeadline) ||
      this.settlementDeadline <= admittedAt ||
      this.settlementDeadline > admittedAt + 600000
    )
      deny("invalid trusted planner operation budget");
    this.operationDeadline =
      selection.operationDeadlineMs ??
      Math.min(this.settlementDeadline, admittedAt + 120000);
    if (
      !Number.isFinite(this.operationDeadline) ||
      this.operationDeadline <= admittedAt ||
      this.operationDeadline > this.settlementDeadline
    )
      deny("invalid trusted planner forward deadline");
    this.cleanupBudget = this.settlementDeadline - this.operationDeadline;
    const env = structuredClone(selection.env ?? ctx.env);
    this.context = { ...ctx, env };
    if (!isAbsolute(selection.cwd))
      deny("planner cwd must be host-selected and absolute");
    for (const scope of selection.binaries) {
      if (!scope || scope !== basename(scope) || scope === "*")
        deny("planner binary must have an exact declared name");
      const selected = ctx.which(scope),
        binary: Binary = { selected };
      if (selected) {
        if (!isAbsolute(selected)) deny("planner executable must be absolute");
        binary.canonical = realpathSync(selected);
        binary.link = lstatSync(selected);
        binary.stat = statSync(binary.canonical);
        if (!binary.stat.isFile() || !(binary.stat.mode & 0o111))
          deny("planner executable is not executable");
      }
      this.binaries.set(scope, binary);
    }
    for (const raw of [
      ...(selection.roots ?? []),
      ...(selection.files ?? []).map((path) => dirname(path)),
    ]) {
      let logical = absolutePath(raw);
      for (;;) {
        try {
          lstatSync(logical);
          break;
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== "ENOENT" ||
            logical === dirname(logical)
          )
            throw error;
          logical = dirname(logical);
        }
      }
      const canonical = realpathSync(logical),
        stat = statSync(canonical);
      if (!stat.isDirectory()) deny("planner source root must be a directory");
      this.fileRoots.push({ logical, canonical, stat });
    }
    // A later mutable ctx.which cannot select a new executable for compensation.
    this.context.which = (name) => this.binaries.get(name)?.selected ?? null;
  }
  bind(peer: CallAuthority, method: string): void {
    // Read-only operations get no installation borrow, even with every grant.
    const readonly =
      this.selection.purpose === "preview" &&
      [
        "planner.plan",
        "planner.preview",
        "planner.detect",
        "planner.check",
      ].includes(method);
    if (
      !readonly &&
      method !== "planner.install" &&
      method !== "planner.uninstall"
    )
      return;
    if (
      !readonly &&
      (method === "planner.uninstall"
        ? this.selection.purpose !== "uninstall"
        : this.selection.purpose === "uninstall")
    )
      deny("planner operation purpose mismatch");
    if (this.peer || this.closed) deny("planner owner cannot be rebound");
    peer.assertActive();
    this.peer = peer;
    borrows.set(peer, this);
    peer.onRevoke(async () => {
      this.closed = true;
      this.prior = undefined;
      borrows.delete(peer);
      // Drain/terminate only admitted forward work. Undo owners survive this hook.
      await this.active?.revoke();
    });
  }
  prepareInput(input: unknown, fits: (value: unknown) => boolean): unknown {
    if (!this.peer || this.closed)
      deny("planner input requires an active borrow");
    this.peer!.assertActive();
    const captured = structuredClone(input) as Record<string, unknown>;
    if (fits(captured)) return captured;
    if (!Object.hasOwn(captured, "prior"))
      throw new CoreError("too_large", "planner input frame exceeds limit");
    const bytes = Buffer.from(JSON.stringify(captured.prior)),
      handle = randomUUID();
    delete captured.prior;
    captured.priorRange = { handle, bytes: bytes.length };
    if (!fits(captured))
      throw new CoreError(
        "too_large",
        "planner input metadata exceeds frame limit",
      );
    this.prior = { handle, bytes };
    return captured;
  }
  async readPrior(
    peer: CallAuthority,
    params: Record<string, unknown>,
  ): Promise<{ base64: string }> {
    peer.assertGranted("fs.read");
    if (
      this.peer !== peer ||
      this.closed ||
      !this.prior ||
      params.handle !== this.prior.handle
    )
      deny("prior record handle does not belong to active planning call");
    const { offset, length } = params;
    if (
      !Number.isSafeInteger(offset) ||
      (offset as number) < 0 ||
      !Number.isSafeInteger(length) ||
      (length as number) < 0 ||
      (length as number) > 262144 ||
      (offset as number) + (length as number) > this.prior!.bytes.length
    )
      throw new CoreError("invalid_input", "invalid prior record range");
    return {
      base64: this.prior!.bytes.subarray(
        offset as number,
        (offset as number) + (length as number),
      ).toString("base64"),
    };
  }
  private captureDirectories(raw: string): void {
    for (let path = raw; ; path = dirname(path)) {
      try {
        const stat = lstatSync(path);
        if (stat.isDirectory()) {
          const canonical = realpathSync(path),
            prior = this.observedDirectories.get(path);
          if (
            prior &&
            (prior.canonical !== canonical ||
              prior.stat.dev !== stat.dev ||
              prior.stat.ino !== stat.ino ||
              prior.stat.mode !== stat.mode)
          )
            deny("planner observed ancestor changed");
          if (!prior) this.observedDirectories.set(path, { canonical, stat });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (path === dirname(path)) break;
    }
  }
  assertFileRoots(): void {
    for (const root of [
      ...this.fileRoots,
      ...[...this.observedDirectories].map(([logical, value]) => ({
        logical,
        ...value,
      })),
    ]) {
      const current = statSync(root.canonical);
      if (
        realpathSync(root.logical) !== root.canonical ||
        root.stat.dev !== current.dev ||
        root.stat.ino !== current.ino ||
        root.stat.mode !== current.mode
      )
        deny("planner source root changed since operation admission");
    }
  }
  permits(path: string): boolean {
    const contains = (root: string, value: string) =>
      value === root || value.startsWith(root + sep);
    if (plannerPrivatePath(this.context, path)) return false;
    return (
      (this.selection.roots ?? []).some((root) =>
        contains(resolve(root), path),
      ) ||
      (this.selection.files ?? []).some(
        (file) =>
          path === file ||
          (path.startsWith(file + ".pacer-bak-") &&
            /^\d{8}-\d{6}(?:-\d+)?$/.test(
              path.slice((file + ".pacer-bak-").length),
            )),
      )
    );
  }
  async read(
    peer: CallAuthority,
    scopes: readonly string[],
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    peer.assertGranted("fs.read");
    if (this.peer !== peer || this.closed)
      deny("planner source admission expired");
    if (method === "capability.fs.list") {
      const dir = absolutePath(params.dir);
      if (!this.permits(dir) || !declaredPath(peer, scopes, dir, true))
        deny("planner discovery outside selected root");
      try {
        const stat = lstatSync(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          deny("planner discovery requires a regular directory");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return { files: [], complete: true };
        throw error;
      }
      this.captureDirectories(dir);
      const files = [];
      for await (const path of new Bun.Glob(params.glob as string).scan({
        cwd: dir,
        absolute: true,
        onlyFiles: true,
        followSymlinks: false,
        throwErrorOnBrokenSymlink: true,
      })) {
        peer.assertActive();
        if (!this.permits(path) || !declaredPath(peer, scopes, path)) continue;
        const reply = (await this.read(peer, scopes, "capability.fs.stat", {
          path,
        })) as { info?: unknown };
        if (reply.info) files.push(reply.info);
        if (files.length > 1000)
          throw new CoreError(
            "too_large",
            "planner source discovery exceeds limit",
          );
      }
      return { files, complete: true };
    }
    const path = absolutePath(params.path);
    if (!this.permits(path) || !declaredPath(peer, scopes, path))
      deny("planner source outside selected root or declared scope");
    this.assertFileRoots();
    this.captureDirectories(dirname(path));
    let parent = path;
    for (;;) {
      try {
        const stat = lstatSync(parent);
        if (stat.isSymbolicLink() && !["/var", "/tmp", "/etc"].includes(parent))
          deny("planner source symlink refused");
        if (parent === path && stat.isFile() && stat.nlink !== 1)
          deny("planner source hardlink refused");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (parent === dirname(parent)) break;
      parent = dirname(parent);
    }
    const owner = createCallAuthority(
      this.context,
      { reads: [{ path, kind: "file" }], commands: [], stores: [] },
      {
        deadlineMs: peer.deadlineMs,
        signal: peer.signal,
        grants: ["fs.read"],
        accountHome: peer.accountHome,
      },
    );
    try {
      await prepareFilesystemAuthority(owner);
      return await answerFilesystem(owner, scopes, method, params);
    } finally {
      await owner.revoke();
    }
  }
  private pin(
    argv: readonly string[],
    timeoutMs: number,
    scopes: readonly string[],
    compensation = false,
  ) {
    const scope =
      [...this.binaries].find(
        ([name, binary]) => argv[0] === name || argv[0] === binary.selected,
      )?.[0] ?? deny("planner executable is outside host selection");
    if (!scopes.includes(scope)) deny("planner executable was not declared");
    if (!allowedPlannerCommand(scope, argv, this.selection.pacerArgv) && !this.commandApproval?.(argv)) deny("planner command is not an allowed integration operation");
    const binary = this.binaries.get(scope)!;
    if (binary.selected) {
      try {
        if (
          realpathSync(binary.selected) !== binary.canonical ||
          !same(lstatSync(binary.selected), binary.link!) ||
          !same(statSync(binary.canonical!), binary.stat!)
        )
          deny("planner executable changed since admission");
      } catch (error) {
        if (error instanceof CoreError) throw error;
        deny("planner executable unavailable");
      }
    }
    const params = {
      argv: [scope, ...argv.slice(1)],
      timeoutMs,
      cwd: this.selection.cwd,
      env: plannerEnvironment(this.context.env),
    };
    const owner = createCallAuthority(
      this.context,
      { reads: [], stores: [], commands: [params] },
      {
        deadlineMs: compensation
          ? this.settlementDeadline
          : Math.min(this.operationDeadline, this.peer!.deadlineMs),
        grants: ["process.spawn"],
      },
    );
    this.owners.add(owner);
    prepareSpawnAuthority(owner);
    return { owner, scope, params, argv: [...argv] };
  }
  async run(
    peer: CallAuthority,
    scopes: readonly string[],
    input: unknown,
  ): Promise<unknown> {
    peer.assertGranted("process.spawn");
    if (
      this.peer !== peer ||
      this.closed ||
      this.selection.purpose === "reconcile" ||
      this.selection.purpose === "preview"
    )
      deny("planner effect admission is closed or read-only");
    const parsed = plannerCommandIntent.safeParse(input);
    if (!parsed.success)
      throw new CoreError("invalid_input", "invalid planner command intent");
    const intent = structuredClone(parsed.data);
    const size = Buffer.byteLength(JSON.stringify(intent));
    if (this.count >= 64 || this.bytes + size > 1048576)
      throw new CoreError("too_large", "planner command budget exceeded");
    if (this.active) deny("planner command already active");
    if (Date.now() >= this.operationDeadline)
      deny("planner forward budget expired");
    const newUndo =
      intent.undo &&
      !this.undos.some(
        (value) => JSON.stringify(value.argv) === JSON.stringify(intent.undo),
      );
    if (newUndo && this.reservedUndoMs + intent.timeoutMs > this.cleanupBudget)
      throw new CoreError(
        "too_large",
        "planner undo work exceeds reserved cleanup budget",
      );
    // Pin both vectors and capture immutable compensation before forward spawn.
    if (this.output) discardSpawnOutput(this.output);
    this.output = undefined;
    const forward = this.pin(intent.argv, intent.timeoutMs, scopes);
    const undo = newUndo
      ? this.pin(intent.undo!, intent.timeoutMs, scopes, true)
      : undefined;
    peer.assertActive();
    if (this.closed) deny("planner effect admission closed during pinning");
    this.count++;
    this.bytes += size;
    if (undo) {
      this.undos.push(undo);
      this.reservedUndoMs += intent.timeoutMs;
    }
    this.active = forward.owner;
    this.output = forward.owner;
    try {
      return await answerSpawn(forward.owner, [forward.scope], forward.params);
    } finally {
      this.active = undefined;
    }
  }
  async readOutput(peer: CallAuthority, params: Record<string, unknown>) {
    peer.assertGranted("process.spawn");
    if (this.peer !== peer || this.closed || !this.output)
      deny("planner output owner expired");
    return await readSpawnOutput(this.output!, params);
  }
  allowsPreparedResult(authority: CallAuthority, method: string): boolean {
    return (
      this.peer === authority &&
      !this.closed &&
      (method === "planner.uninstall"
        ? this.selection.purpose === "uninstall"
        : method === "planner.install" &&
          (this.selection.purpose === "install" ||
            this.selection.purpose === "reconcile"))
    );
  }
  commandUndos(): string[][] {
    return this.undos.map((value) => [...value.argv]);
  }
  rollback(): Promise<void> {
    if (this.rollbackWork) return this.rollbackWork;
    this.closed = true;
    this.rollbackWork = (async () => {
      await this.active?.revoke();
      const failures: unknown[] = [];
      for (const undo of [...this.undos].reverse()) {
        try {
          const result = (await answerSpawn(
            undo.owner,
            [undo.scope],
            undo.params,
          )) as { code: number };
          if (result.code !== 0)
            failures.push(
              new CoreError(
                "plugin_unavailable",
                "planner compensation command failed",
              ),
            );
        } catch (error) {
          failures.push(error);
        } finally {
          discardSpawnOutput(undo.owner);
        }
      }
      if (failures.length)
        throw new CoreError(
          "plugin_unavailable",
          `planner compensation failed for ${failures.length} admitted command(s); every undo was attempted`,
        );
    })();
    return this.rollbackWork;
  }
  async dispose(): Promise<void> {
    this.closed = true;
    this.prior = undefined;
    if (this.peer) borrows.delete(this.peer);
    const results = await Promise.allSettled(
      [...this.owners].map((owner) => owner.revoke()),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    this.owners.clear();
  }
}
export function plannerBorrow(
  authority: CallAuthority,
): PlannerResources | undefined {
  return borrows.get(authority);
}

/** Negotiated staging is limited to the exact trusted pending effect purpose. */
export function plannerPreparedResultAllowed(
  authority: CallAuthority | undefined,
  method: string,
): boolean {
  if (!authority) return false;
  const lease = borrows.get(authority);
  return !!lease && lease.allowsPreparedResult(authority, method);
}
