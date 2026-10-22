/** Private signed-parent bootstrap. JSON describes launch intent; it grants no authority. */
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { z } from "zod";
import { CoreError } from "../../core/errors";
import type { Ctx } from "../../types";
import { currentVersion, isVersion } from "../version";
import { BUNDLE_RELEASE_PATH, parseBundleRelease } from "./identity";
import { compiledNativeFixture, verifyNativeFixture } from "./native-fixture";
import { compiledSignerPins, DarwinAuthority } from "./native-os";
import { pairedServiceOwner, type NativeServiceOwner } from "./native-service-owner";
import { receiveParentHelperChannel, receiveParentListener, type ParentNativeListener } from "./native-socket";
import { ParentHelperSpawner } from "./native-parent-helper";
import { ownProcessIdentity, processIdentity, sameProcess } from "./process-identity";

const KEY = "PACER_INTERNAL_NATIVE_BOOTSTRAP";
const schema = z.object({
  schema: z.literal(1),
  argv: z.array(z.string().min(1).max(4096).refine(value => !value.includes("\0"))).min(2).max(4),
  frontVersion: z.string().max(128).refine(isVersion),
}).strict();
export type NativePairedBootstrapInput = z.infer<typeof schema>;
export interface PairedNativeBootstrap {
  owner: NativeServiceOwner;
  listener: ParentNativeListener;
  helpers?: ParentHelperSpawner;
  /** Fixed private-channel request to the owned root generation; never a PID signal. */
  shutdown(): void;
}
const denied = () => new CoreError("not_allowed", "Native paired bootstrap could not be verified");

/** Call before copying environments or launching any task, including generic builds. */
export function consumeNativePairedBootstrap(env: Record<string, string | undefined>): NativePairedBootstrapInput | null {
  const captured = env[KEY], ambient = process.env[KEY];
  delete env[KEY];
  delete process.env[KEY];
  if (captured !== undefined && ambient !== undefined && captured !== ambient) throw denied();
  const text = captured ?? ambient;
  if (text === undefined) return null;
  try {
    if (Buffer.byteLength(text) > 65536) throw denied();
    return schema.parse(JSON.parse(text));
  } catch { throw denied(); }
}

/** Kernel metadata only: never read a byte or descriptor before authenticating fd0. */
function parentAuditToken(): Uint8Array {
  const api = dlopen("/usr/lib/libSystem.B.dylib", {
    getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });
  try {
    const token = new Uint8Array(32), size = new Uint32Array([32]);
    if (api.symbols.getsockopt(0, 0, 6, ptr(token), ptr(size)) !== 0 || size[0] !== 32) throw denied();
    return token;
  } finally { api.close(); }
}
function owned(path: string, uid: number, directory: boolean, executable = false): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())
    || info.uid !== uid || info.mode & 0o022 || (!directory && info.nlink !== 1)
    || executable && !(info.mode & 0o111) || realpathSync(path) !== path) throw denied();
  if (executable) accessSync(path, constants.X_OK);
}
function releaseBytes(app: string, uid: number): string {
  const path = join(app, BUNDLE_RELEASE_PATH);
  owned(path, uid, false);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== uid || before.nlink !== 1 || before.mode & 0o022 || before.size > 65536) throw denied();
    const buffer = Buffer.alloc(65537);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    const bytes = buffer.subarray(0, size);
    const after = fstatSync(fd), linked = lstatSync(path);
    if (bytes.length > 65536 || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || linked.dev !== after.dev || linked.ino !== after.ino || linked.isSymbolicLink()) throw denied();
    return bytes.toString("utf8");
  } finally { closeSync(fd); }
}

/** Production factory has no injectable authority/FD/path; all trust is compiled and OS-verified. */
export function configuredPairedNativeBootstrap(
  ctx: Ctx,
  port: number,
  bootstrap: NativePairedBootstrapInput | null,
): PairedNativeBootstrap | null {
  if (!bootstrap) return null;
  let listener = -1, helperChannel = -1;
  try {
    // Revalidate even typed callers; no additional selectors are accepted.
    const input = schema.parse(bootstrap);
    const pins = compiledSignerPins(), fixture = compiledNativeFixture();
    if (process.platform !== "darwin" || !pins && !fixture?.signingCertSha1 || pins && fixture) throw denied();
    if (fixture) {
      verifyNativeFixture(fixture);
      if (fixture.home !== realpathSync(ctx.pacerHome) || fixture.port !== port) throw denied();
    }
    const authority = DarwinAuthority.configured(), uid = process.getuid?.();
    const own = ownProcessIdentity(), parent = processIdentity(process.ppid);
    if (!authority || uid === undefined || !own || !parent) throw denied();
    const token = parentAuditToken();
    const front = authority.verifyPeer(token, "cli", parent);
    const core = authority.verifyProcess(own, "cli");
    if (!sameProcess(front.process, parent) || core.parentPid !== process.ppid
      || !core.executable || core.executable !== realpathSync(process.execPath)) throw denied();
    const resources = dirname(core.executable), contents = dirname(resources), app = dirname(contents);
    for (const path of [app, contents, resources]) owned(path, uid, true);
    owned(core.executable, uid, false, true);
    owned(front.executable, uid, false, true);
    authority.verifyStatic(app, "desktop");
    authority.verifyStatic(core.executable, "cli");
    authority.verifyStatic(front.executable, "cli");
    const metadata = releaseBytes(app, uid), release = parseBundleRelease(JSON.parse(metadata));
    const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : null;
    if (!arch) throw denied();
    const owner = pairedServiceOwner({ core, front, own, release, argv: input.argv,
      version: currentVersion(), frontVersion: input.frontVersion, arch, uid, port });
    const recheck = () => {
      authority.verifyStatic(app, "desktop");
      authority.verifyStatic(core.executable!, "cli");
      authority.verifyStatic(front.executable, "cli");
      for (const path of [app, contents, resources]) owned(path, uid, true);
      owned(core.executable!, uid, false, true);
      owned(front.executable, uid, false, true);
      const nextCore = authority.verifyProcess(own, "cli"), nextFront = authority.verifyPeer(token, "cli", parent);
      if (!sameProcess(nextCore.process, core.process) || nextCore.parentPid !== parent.pid
        || nextCore.executable !== core.executable || nextCore.uid !== uid
        || !sameProcess(nextFront.process, front.process) || nextFront.executable !== front.executable
        || nextFront.uid !== uid || releaseBytes(app, uid) !== metadata) throw denied();
    };
    recheck();
    // Only the fixed authenticated parent channel can supply this descriptor.
    listener = receiveParentListener();
    helperChannel = receiveParentHelperChannel();
    recheck();
    const helpers = new ParentHelperSpawner(helperChannel);
    let sent = false;
    return { owner, helpers, listener: { fd: listener, owner: { ...owner.process } }, shutdown() {
      if (sent) return;
      if (writeSync(0, Buffer.from("S")) !== 1) throw denied();
      sent = true;
      helpers.close();
    } };
  } catch {
    if (listener >= 0) closeSync(listener);
    if (helperChannel >= 0) closeSync(helperChannel);
    throw denied();
  }
}
