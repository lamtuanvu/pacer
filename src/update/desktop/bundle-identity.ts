/** Compiled desktop bundle and code-signing identifiers. No runtime value selects them. */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { compiledNativeFixture } from "./native-fixture";

/** Moved from the retired native identity module; still used by the update manager. */
export function isBundledExecutable(execPath: string): boolean {
  const bundled = (path: string) => /\.app\/Contents\/(?:Resources|MacOS)\/.+/i.test(path);
  if (bundled(resolve(execPath))) return true;
  try { return bundled(realpathSync(execPath)); } catch { return false; }
}

export type DesktopIdentifiers = {
  readonly desktop: string;
  readonly cli: string;
  readonly nativeShim: string;
  readonly helper: string;
};
export const RELEASE_IDENTIFIERS: DesktopIdentifiers = Object.freeze({
  desktop: "dev.pacer.desktop",
  cli: "dev.pacer.cli",
  nativeShim: "dev.pacer.desktop.native-shim",
  helper: "dev.pacer.desktop.update-helper",
});
/** Fixture builds run beside the user's app and never satisfy a release check. */
export const FIXTURE_IDENTIFIERS: DesktopIdentifiers = Object.freeze({
  desktop: "dev.pacer.desktop.fixture",
  cli: "dev.pacer.desktop.fixture.cli",
  nativeShim: "dev.pacer.desktop.fixture.native-shim",
  helper: "dev.pacer.desktop.fixture.update-helper",
});
export function desktopIdentifiers(fixture: boolean): DesktopIdentifiers {
  return fixture ? FIXTURE_IDENTIFIERS : RELEASE_IDENTIFIERS;
}
/** A binary compiled with a fixture lease never claims the release identity, even when the lease is invalid. */
function compiledAsFixture(): boolean {
  try {
    return compiledNativeFixture() !== null;
  } catch {
    return true;
  }
}
export const DESKTOP_IDENTIFIERS = desktopIdentifiers(compiledAsFixture());
