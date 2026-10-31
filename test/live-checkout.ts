import { cpSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";
import { assertPacerHomeAllowed } from "../src/ctx";

/** Relocate the harness, not its safety policy: liveRoot is derived from import.meta.dir. */
export function liveTestCheckout(): string {
  const root = realpathSync(tmpDir());
  assertPacerHomeAllowed(join(root, ".work/live", "preflight", "home"));
  const source = join(import.meta.dir, "..");
  cpSync(join(source, "scripts"), join(root, "scripts"), { recursive: true });
  // Only the harness needs a distinct module identity. Product code and inert seed
  // inputs stay on this revision; no git checkout, user state or credentials are copied.
  for (const entry of ["src", "plugins", "packages", "node_modules", "package.json"]) {
    symlinkSync(join(source, entry), join(root, entry));
  }
  mkdirSync(join(root, "test"));
  symlinkSync(join(source, "test/fixtures"), join(root, "test/fixtures"));
  return root;
}
