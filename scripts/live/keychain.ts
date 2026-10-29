import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { homeTag } from "../../src/identity/key-store";
import { defaultRun } from "../../src/ctx";
import type { RunFn } from "../../src/types";
import type { Session } from "./core";

/**
 * A `security` stand-in that keeps generic passwords as files under `store`, so a sandbox never writes the login
 * Keychain. It prints values the way `security -w` does: text when printable, hex otherwise.
 */
export function installKeychainStub(bin: string, store: string, bun = process.execPath): void {
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  mkdirSync(store, { recursive: true, mode: 0o700 });
  writeFileSync(join(bin, "security"), `#!${bun}
const { existsSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const store = ${JSON.stringify(store)};
const flag = (a, f) => { const i = a.indexOf(f); return i < 0 ? "" : a[i + 1] ?? ""; };
function one(a) {
  const file = require("node:path").join(store, flag(a, "-s") + "." + flag(a, "-a").replaceAll("/", "_"));
  switch (a[0]) {
    case "add-generic-password": writeFileSync(file, flag(a, "-X"), { mode: 0o600 }); return 0;
    case "find-generic-password": {
      if (!existsSync(file)) return 44;
      if (!a.includes("-w")) return 0;
      const v = Buffer.from(readFileSync(file, "utf8"), "hex");
      process.stdout.write(([...v].every(b => b >= 0x20 && b < 0x7f) ? v.toString("latin1") : v.toString("hex")) + "\\n");
      return 0;
    }
    case "delete-generic-password": if (!existsSync(file)) return 44; rmSync(file); return 0;
  }
  return 1;
}
const args = process.argv.slice(2);
if (args[0] === "-i") {
  for (const line of readFileSync(0, "utf8").split("\\n").filter(Boolean)) { const code = one(line.split(" ")); if (code) process.exit(code); }
  process.exit(0);
}
process.exit(one(args));
`);
  chmodSync(join(bin, "security"), 0o755);
}

/** Put the stub first on the sandbox PATH unless the session opted into the real Keychain. */
export function prepareKeychain(session: Pick<Session, "root" | "realKeychain">): void {
  if (!session.realKeychain) installKeychainStub(join(session.root, "bin"), join(session.root, "keychain"));
}

const PREFIXES = ["machine-identity", "machine-identity-staging", "machine-install-salt"];

/**
 * Delete the machine identity items of every pacer home in a real-Keychain sandbox: `home`, and any copy made
 * directly under the sandbox root. Refuses, before deleting anything, if a home has the real home's tag.
 */
export async function deleteSandboxKeychainItems(root: string, run: RunFn = defaultRun, realHome = join(homedir(), ".pacer")): Promise<string[]> {
  const homes = readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(root, d.name, "identity", "machine.json")))
    .map(d => join(root, d.name));
  if (existsSync(join(root, "home")) && !homes.includes(join(root, "home"))) homes.push(join(root, "home"));
  const realTag = homeTag({ pacerHome: realHome });
  const tags = homes.map(pacerHome => homeTag({ pacerHome }));
  if (tags.includes(realTag)) throw Error("Refusing Keychain cleanup: a sandbox home has the real pacer home's tag");
  const security = existsSync("/usr/bin/security") ? "/usr/bin/security" : "security";
  const deleted: string[] = [];
  for (const tag of tags) for (const prefix of PREFIXES) {
    const account = `${prefix}/${tag}`;
    const r = await run([security, "delete-generic-password", "-s", "pacer", "-a", account], 10000);
    if (r.code === 0) deleted.push(account);
    else if (r.code !== 44) throw Error(`Keychain cleanup failed for ${account} (exit ${r.code})`);
  }
  return deleted;
}
