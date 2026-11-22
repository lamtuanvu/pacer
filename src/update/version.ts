import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SEMVER } from "@pacer/protocol-schema/shared/semver";
export { isVersion, compareVersions } from "@pacer/protocol-schema/shared/semver";

/** Replaced at compile time by the local and release build scripts. */
declare const PACER_BUILD_VERSION: string | undefined;

/** Fallback for a compiled binary built without the version define. */
export const DEV_VERSION = "0.0.0-dev";

export function currentVersion(): string {
  if (typeof PACER_BUILD_VERSION === "string") return PACER_BUILD_VERSION;
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && SEMVER.test(pkg.version) ? pkg.version : DEV_VERSION;
  } catch {
    return DEV_VERSION;
  }
}