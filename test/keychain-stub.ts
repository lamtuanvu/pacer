import { join } from "node:path";
import { installKeychainStub } from "../scripts/live/keychain";
import { tmpDir } from "./helpers";

/**
 * A PATH for spawned services that resolves `security` to a file-backed stub under `root`, so a spawned pacer
 * never writes machine identity items into the developer's login Keychain. test/setup.ts installs one for the
 * whole run; spawned-service tests use their own so their items stay with their temp home.
 */
export function keychainStubPath(root = tmpDir(), path = process.env.PATH ?? "/usr/bin:/bin"): string {
  installKeychainStub(join(root, "bin"), join(root, "keychain"));
  return `${join(root, "bin")}:${path}`;
}
