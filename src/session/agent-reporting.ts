import { privateWrite } from "../private-file";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentSessionLaunch } from "@pacer/plugin";

/** Materialize adapter-owned reporting without giving the plugin account settings. */
export function materializeAgentReporting(dir: string, launch: AgentSessionLaunch, env: Record<string, string | undefined>): void {
  const reporting = launch.reporting;
  if (!reporting) return;
  const {configEnv, configKey} = reporting;
  let config: unknown;
  try { config = JSON.parse(env[configEnv] ?? "{}"); }
  catch { throw Error(`Invalid ${configEnv}: expected a JSON object`); }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw Error(`Invalid ${configEnv}: expected a JSON object`);
  const object = config as Record<string, unknown>;
  const plugins = object[configKey] ?? [];
  if (!Array.isArray(plugins)) throw Error(`Invalid ${configEnv}.${configKey}: expected an array`);
  const folder = join(dir, "report-plugin");
  privateWrite(join(folder, "index.ts"), reporting.source);
  env[configEnv] = JSON.stringify({...object, [configKey]: [...new Set([...plugins, folder])]});
}
