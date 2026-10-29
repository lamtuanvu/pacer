/** Optional build scratch on an owned mounted filesystem; not a native lease resource. */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, normalize, resolve } from "node:path";

export interface ExternalCargoTargetIdentity {
  path: string;
  uid: number;
  dev: number;
  ino: number;
}

function privateDirectory(path: string, uid: number) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.mode & 0o077)
    throw Error("External Cargo target requires a private owned directory");
  return stat;
}

/** Inspect before signer or lease reservation. The caller supplies the real session device. */
export function validateExternalCargoTarget(path: string, id: string, sessionDevice: number): ExternalCargoTargetIdentity {
  if (!/^[A-Za-z0-9_-]+$/.test(id) || !isAbsolute(path) || normalize(path) !== path || resolve(path) !== path ||
      basename(path) !== `pacer-live-cargo-${id}` || basename(dirname(path)) !== ".work" ||
      realpathSync(path) !== path) throw Error("External Cargo target must be canonical and fixture-scoped");
  const uid = process.getuid?.();
  if (uid === undefined) throw Error("External Cargo target owner is unavailable");
  privateDirectory(dirname(path), uid);
  const stat = privateDirectory(path, uid);
  if (stat.dev === sessionDevice) throw Error("External Cargo target requires a different filesystem");
  if (readdirSync(path).length) throw Error("External Cargo target must be empty before build");
  return { path, uid, dev: stat.dev, ino: stat.ino };
}

/** Recheck identity before every build stage and before consuming Cargo outputs. */
export function assertExternalCargoTargetIdentity(expected: ExternalCargoTargetIdentity): void {
  if (realpathSync(expected.path) !== expected.path) throw Error("External Cargo target canonical identity changed");
  privateDirectory(dirname(expected.path), expected.uid);
  const stat = privateDirectory(expected.path, expected.uid);
  if (stat.dev !== expected.dev || stat.ino !== expected.ino) throw Error("External Cargo target identity changed");
}
