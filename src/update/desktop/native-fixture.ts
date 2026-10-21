/** Dedicated compiled fixture policy. Runtime environment cannot enable this mode. */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { z } from "zod";
import { createHash } from "node:crypto";
import { CoreError } from "../../core/errors";
declare const PACER_BUILD_OTA_FIXTURE: string | undefined;
const schema = z
  .object({
    schema: z.literal(1),
    root: z.string(),
    nonce: z.string().regex(/^[a-f0-9]{32}$/),
    home: z.string(),
    port: z.number().int().min(1).max(65535),
    currentApp: z.string(),
    serviceLabel: z.string(),
    recoveryLabel: z.string(),
    uid: z.number().int().nonnegative(),
    signingCertSha1: z.string().regex(/^[0-9A-F]{40}$/).optional(),
  })
  .strict();
export type NativeFixture = z.infer<typeof schema>;
const denied = () =>
  new CoreError(
    "not_allowed",
    "Native fixture lease does not match this build",
  );
export function parseNativeFixture(text: string): NativeFixture {
  try {
    const p = schema.parse(JSON.parse(text)),
      parent = dirname(p.root);
    if (
      [p.root, p.home, p.currentApp].some(
        (path) =>
          !isAbsolute(path) || normalize(path) !== path || path.includes("\0"),
      ) ||
      !p.root.endsWith("/.work/live/" + parent.split("/").at(-1) + "/ota") ||
      p.home !== join(parent, "home") ||
      p.currentApp !== join(p.root, "current.app") ||
      p.port === 4317 ||
      p.serviceLabel !== `com.pacer.live.${p.nonce}.service` ||
      p.recoveryLabel !== `com.pacer.live.${p.nonce}.recovery`
    )
      throw denied();
    return p;
  } catch {
    throw denied();
  }
}
export function compiledNativeFixtureSha256(): string | null {
  if (!compiledNativeFixture()) return null;
  return createHash("sha256").update(PACER_BUILD_OTA_FIXTURE!).digest("hex");
}
export function compiledNativeFixture(): NativeFixture | null {
  if (typeof PACER_BUILD_OTA_FIXTURE !== "string" || !PACER_BUILD_OTA_FIXTURE)
    return null;
  return parseNativeFixture(PACER_BUILD_OTA_FIXTURE);
}
export function verifyNativeFixture(policy: NativeFixture): void {
  if (policy.uid !== process.getuid?.()) throw denied();
  for (const path of [policy.root, policy.home, dirname(policy.root)]) {
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== policy.uid ||
      stat.mode & 0o077 ||
      realpathSync(path) !== path
    )
      throw denied();
  }
  const fd = openSync(
    join(policy.root, "record.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== policy.uid ||
      stat.mode & 0o077 ||
      stat.size > 65536
    )
      throw denied();
    const record = JSON.parse(readFileSync(fd, "utf8")),
      expected = {
        schema: 1,
        phase: "prepared",
        root: policy.root,
        nonce: policy.nonce,
        pacerHome: policy.home,
        innerPort: policy.port,
        currentApp: policy.currentApp,
        serviceLabel: policy.serviceLabel,
        recoveryLabel: policy.recoveryLabel,
        ownerUid: policy.uid,
      };
    if (Object.entries(expected).some(([key, value]) => record[key] !== value))
      throw denied();
  } finally {
    closeSync(fd);
  }
}
export function fixturePermitsPath(policy: NativeFixture, path: string): void {
  verifyNativeFixture(policy);
  if (
    realpathSync(path) !== path ||
    !(
      path === policy.root ||
      path.startsWith(policy.root + "/") ||
      path.startsWith(join(policy.home, "desktop-updates/native") + "/")
    )
  )
    throw denied();
}

/** Inventory isolation only; this never verifies or authorizes an executable. */
export function fixtureProcessInScope(policy: NativeFixture, executable: string | null): boolean {
  return !!executable && isAbsolute(executable) && normalize(executable) === executable &&
    (executable.startsWith(policy.root + "/") || executable.startsWith(join(policy.home, "desktop-updates/native") + "/"));
}
