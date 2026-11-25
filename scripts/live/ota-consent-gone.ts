/** Pure helpers for the consent-gone-formula live driver (formula → cask switch). */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePlistDictionary } from "../../src/service";

/** Seed a CLI owner record naming the attached formula path. */
export function seedCliOwnerRecord(pacerHome: string, executable: string, at = Math.floor(Date.now() / 1000)): void {
  writeFileSync(join(pacerHome, "owner.json"), JSON.stringify({ schema: 1, owner: "cli", executable, at: Math.floor(at) }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}

/** Require the managed rewrite after a gone formula program: bundled argv + fixture HOME/PACER_HOME/PACER_PORT. */
export function assertGoneFormulaManagedRegistration(
  registrationText: string,
  bundled: string,
  home: string,
  port: number,
): void {
  const data = parsePlistDictionary(registrationText);
  const argv = data.ProgramArguments;
  const env = data.EnvironmentVariables;
  if (!Array.isArray(argv) || argv[0] !== bundled || argv[1] !== "serve") {
    throw Error("Gone-formula registration was not rewritten to the bundled CLI");
  }
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw Error("Gone-formula registration is missing EnvironmentVariables");
  }
  const values = env as Record<string, unknown>;
  if (values.HOME !== home || values.PACER_HOME !== home || values.PACER_PORT !== String(port)) {
    throw Error("Gone-formula registration environment does not match the fixture HOME/PACER_HOME/PACER_PORT");
  }
}
