import { z } from "zod";
import type { MethodDef } from "./protocol";
import { secretReference } from "./http-protocol";

const path = z.string().min(1).max(4096), handle = z.string().min(1).max(256);
/** Longest host-issued provider process effect; owning call deadlines remain authoritative. */
export const MAX_PROCESS_SPAWN_MS = 30 * 60 * 1000;
const bytes = z.number().int().nonnegative().safe();
const chunk = bytes.max(262144);
const base64 = z.string().max(349528).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const duplexHandle = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
export const fileInfo = z.object({ path, size: bytes, mtimeMs: z.number(), inode: bytes, device: bytes, mode: bytes.optional() });
const identity = fileInfo.omit({ path: true });
const missing = z.object({ missing: z.literal(true) });
const lease = z.object({ lease: handle }).strict();
const method = (description: string, params: z.ZodTypeAny, result: z.ZodTypeAny, deadlineMs = 5000): MethodDef => ({ description, params, result, deadlineMs });

/** Wire limits bound chunks, not total compatibility state or rich-result size. */
export const SCOPED_CAPABILITY_METHODS: Record<string, MethodDef> = {
  "capability.fs.read": method("Read an authorized regular telemetry file; large encoded replies use pinned ranged metadata.", z.object({ path }).strict(),
    z.union([z.object({ text: z.string(), mtime: z.number(), mode: bytes.optional() }), missing, z.object({ ranged: fileInfo })])),
  "capability.fs.list": method("Exhaustively scan authorized telemetry paths and return the newest bounded metadata set; complete reports whether every match fits.",
    z.object({ dir: path, glob: z.string().min(1).max(4096), limit: z.number().int().positive().max(1000).optional() }).strict(),
    z.object({ files: z.array(fileInfo).max(1000), complete: z.boolean() })),
  "capability.fs.stat": method("Read metadata for an authorized regular file or exact sessions root directory.", z.object({ path }).strict(), z.union([z.object({ info: fileInfo }), missing])),
  "capability.fs.readRange": method("Read a pinned byte range, at most 256 KiB; changed identity fails without partial bytes.",
    z.object({ path, offset: bytes, length: chunk, expected: identity }).strict(), z.union([z.object({ base64, info: fileInfo }), missing])),
  "capability.process.spawn": method("Run only a host-issued pinned command with exact host-owned context and bound credential references.",
    z.object({ argv: z.array(z.string().max(4096)).min(1).max(32), timeoutMs: z.number().int().positive().max(MAX_PROCESS_SPAWN_MS), cwd: path.optional(), stdin: z.string().max(262144).optional(), env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.union([z.string(), z.object({secretRef: secretReference}).strict()])).optional() }).strict(),
    z.union([z.object({ code: z.number().int(), stdout: z.string(), stderr: z.string(), timedOut: z.boolean() }),
      z.object({ code: z.number().int(), output: z.object({ stdout: handle, stderr: handle }), timedOut: z.boolean() })]), 0),
  "capability.process.outputChunk": method("Read a bounded chunk from this call's captured provider output.",
    z.object({ handle, offset: bytes, length: chunk }).strict(), z.object({ base64 })),
  "capability.process.startRun": method("Start the one host-issued task-owned detached run directory wrapper.",
    z.object({ task: z.object({ id: z.string().regex(/^t-[A-Za-z0-9_-]{1,120}$/), rev: z.number().int().positive().safe() }).strict(),
      attempt: z.number().int().positive().safe(), runDir: z.literal(1) }).strict(),
    z.object({ pid: z.number().int().positive().safe() }).strict(), 10_000),
  "capability.process.stopRun": method("Stop one host-issued task-owned detached wrapper with a bounded grace period.",
    z.object({ taskId: z.string().regex(/^t-[A-Za-z0-9_-]{1,120}$/), attempt: z.number().int().positive().safe(),
      graceMs: z.number().int().nonnegative().max(25_000) }).strict(),
    z.object({ code: z.number().int().safe(), killed: z.boolean() }).strict(), 30_000),
  "capability.process.stageBundle": method("Stage one host-issued fixed SSH BUNDLE_OUT binary stream under an owner-bound opaque handle.",
    z.object({ argv: z.array(z.string().max(4096)).min(1).max(32), timeoutMs: z.number().int().positive().max(60_000),
      maxBytes: z.number().int().positive().max(50 * 1024 * 1024) }).strict(),
    z.object({ handle: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
      bytes: bytes.max(50 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(), 70_000),
  "capability.process.duplex.open": method("Open one host-issued fixed SSH session child with private duplex pipes.",
    z.object({ argv: z.array(z.string().max(4096)).min(1).max(32), timeoutMs: z.number().int().positive().max(60_000) }).strict(),
    z.object({ handle: duplexHandle }).strict(), 10_000),
  "capability.process.duplex.read": method("Read one bounded chunk from the call-owned SSH session stdout.",
    z.object({ handle: duplexHandle, length: z.number().int().positive().max(65_536),
      timeoutMs: z.number().int().positive().max(60_000), pollMs: z.number().int().positive().max(1000).optional() }).strict(),
    z.object({ base64: z.string().max(87_384), eof: z.boolean() }).strict(), 65_000),
  "capability.process.duplex.write": method("Write one bounded chunk to the call-owned SSH session stdin.",
    z.object({ handle: duplexHandle, base64: z.string().min(4).max(87_384).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
      timeoutMs: z.number().int().positive().max(60_000) }).strict(),
    z.object({ bytes: z.number().int().positive().max(65_536) }).strict(), 65_000),
  "capability.process.duplex.close": method("Terminate and reap this call's SSH session child.",
    z.object({ handle: duplexHandle, graceful: z.boolean().optional() }).strict(),
    z.object({ ok: z.literal(true), code: z.number().int().min(0).max(255).nullable(),
      signal: z.string().max(32).nullable(), terminated: z.boolean() }).strict(), 5_000),
  "capability.usage.state.begin": method("Lease an opaque host-fixed provider cache or account-projected cursor store.",
    z.object({ store: handle }).strict(), z.object({ lease: handle, bytes, version: z.number().int().positive().optional(), dirty: z.boolean().optional() })),
  "capability.usage.state.readChunk": method("Read at most 256 KiB from this call's projected state snapshot.",
    lease.extend({ offset: bytes, length: chunk }).strict(), z.object({ base64 })),
  "capability.usage.state.stageChunk": method("Stage a contiguous bounded chunk in this call's host-owned private state transfer.",
    lease.extend({ offset: bytes, base64 }).strict(), z.object({ bytes })),
  "capability.usage.state.commit": method("Commit the complete projected JSON state under admitted call ownership; cursor persistence failure retains dirty state.",
    lease.extend({ dirty: z.boolean().optional() }).strict(), z.object({ saved: z.boolean() })),
  "capability.usage.state.release": method("Release a state lease and its private transfer files.", lease, z.object({ ok: z.literal(true) })),
};
export const SCOPED_METHOD_CAPABILITY: Record<string, "fs.read" | "process.spawn" | "usage.state"> = Object.fromEntries(
  Object.keys(SCOPED_CAPABILITY_METHODS).map(name => [name, name.startsWith("capability.fs.") ? "fs.read" : name.startsWith("capability.process.") ? "process.spawn" : "usage.state"]),
) as Record<string, "fs.read" | "process.spawn" | "usage.state">;
