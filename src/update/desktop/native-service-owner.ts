import type { NativePeer, NativeProcess } from "./native-os";
import { sameProcess, type ProcessIdentity } from "./process-identity";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { parseBundleRelease } from "./identity";
import { CoreError } from "../../core/errors";

/** Inputs come only from native code/process verification, never API claims. */
export interface PairedOwnerProof {
  core: NativeProcess;
  front: NativePeer;
  own: ProcessIdentity;
  release: unknown;
  argv: readonly string[];
  version: string;
  frontVersion: string;
  arch: "aarch64" | "x86_64";
  uid: number;
  port: number;
}
export interface NativeServiceOwner {
  process: ProcessIdentity;
  executable: string;
  argv: string[];
  transport: ProcessIdentity;
  appPath: string;
}
export function pairedServiceOwner(proof: PairedOwnerProof): NativeServiceOwner {
  const denied = () => new CoreError("not_allowed", "Native paired service ownership unavailable");
  const { core, front, own, uid, port, argv } = proof;
  const canonical = (path: string | null): path is string => !!path && isAbsolute(path)
    && normalize(path) === path && path.length <= 4096 && !path.includes("\0") && !path.split("/").includes("AppTranslocation");
  if (!Number.isSafeInteger(uid) || uid < 0 || core.uid !== uid || front.uid !== uid
    || !Number.isSafeInteger(port) || port < 1 || port > 65535 || front.role !== "cli"
    || front.auditToken.byteLength !== 32 || !sameProcess(core.process, own)
    || core.parentPid !== front.process.pid || core.process.pid === front.process.pid
    || core.process.bootId !== front.process.bootId || !canonical(core.executable) || !canonical(front.executable)) throw denied();
  for (const identity of [core.process, front.process]) {
    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 1 || !identity.bootId || !identity.birth) throw denied();
  }
  const resources = dirname(core.executable), contents = dirname(resources), appPath = dirname(contents);
  if (basename(core.executable) !== "pacer-core" || basename(resources) !== "Resources"
    || basename(contents) !== "Contents" || !appPath.endsWith(".app")
    || front.executable !== join(resources, "pacer")) throw denied();
  const release = parseBundleRelease(proof.release);
  if (release.cliLayout !== "paired" || release.version !== proof.version || release.version !== proof.frontVersion || release.arch !== proof.arch
    || !release.protocolMajors.includes(3)) throw denied();
  if (argv[0] !== front.executable || argv[1] !== "serve"
    || !(argv.length === 2 || argv.length === 4 && argv[2] === "--port" && argv[3] === String(port))) throw denied();
  return { process: { ...front.process }, executable: front.executable, argv: [...argv],
    transport: { ...core.process }, appPath };
}
