import { randomUUID } from "node:crypto";
import { connectClient } from "../api/client";
import type { ApiClient } from "../api/client-types";
import { isVersion } from "../update/version";
import type { UpdateStatus } from "../update/desktop/types";
import type { Ctx } from "../types";
import type { Command, Result } from "./types";
export const DESKTOP_UPDATE_USAGE = "desktop-update status|check|download|restart|cancel|configure --installation <id> [--json] [--revision <n>] [--request-id <id>] [--version <v>] [--auto-download on|off]";
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export async function desktopUpdateCommand(args: string[], ctx: Ctx, connect: () => Promise<ApiClient> = () => connectClient(ctx, { protocol: 3 })): Promise<Result> {
  const fail = (message: string): Result => ({ code: 2, out: "", err: `pacer desktop-update: ${message}` });
  const [action, ...rest] = args;
  if (!["status", "check", "download", "restart", "cancel", "configure"].includes(action ?? "")) return fail(`usage: pacer ${DESKTOP_UPDATE_USAGE}`);
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!["--installation", "--json", "--revision", "--request-id", "--version", "--auto-download"].includes(flag) || flags[flag] !== undefined) return fail(`unknown or repeated argument ${flag}`);
    if (flag === "--json") { flags[flag] = true; continue; }
    const value = rest[++i]; if (!value || value.startsWith("--")) return fail(`${flag} needs a value`); flags[flag] = value;
  }
  const id = flags["--installation"];
  if (typeof id !== "string" || !identifier.test(id)) return fail("--installation requires a registered installation ID");
  const rawRevision = flags["--revision"], rawRequest = flags["--request-id"];
  if (rawRevision !== undefined && (typeof rawRevision !== "string" || !/^\d+$/.test(rawRevision) || !Number.isSafeInteger(Number(rawRevision)))) return fail("--revision requires a non-negative integer");
  if (rawRequest !== undefined && (typeof rawRequest !== "string" || !identifier.test(rawRequest))) return fail("--request-id is invalid");
  if (action === "status" && [rawRevision, rawRequest, flags["--version"], flags["--auto-download"]].some(v => v !== undefined)) return fail("status accepts only --installation and --json");
  const version = flags["--version"];
  if (action === "restart" && (rawRevision === undefined || typeof version !== "string" || !isVersion(version))) return fail("restart requires the displayed --version and --revision");
  if (action !== "restart" && version !== undefined) return fail("--version is only for restart");
  const auto = flags["--auto-download"];
  if (action === "configure" && auto !== "on" && auto !== "off") return fail("configure requires --auto-download on|off");
  if (action !== "configure" && auto !== undefined) return fail("--auto-download is only for configure");
  let client: ApiClient | undefined;
  try {
    client = await connect();
    if (client.kind === "inprocess") return fail("a running service with a verified desktop connection is required");
    const op = `desktop.update.${action}`, hello = await client.hello();
    if (!hello.protocol.startsWith("3.") || !hello.ops.includes(op)) return fail("the service does not support desktop updates; upgrade the supported desktop/service baseline");
    const params: Record<string, unknown> = { installationId: id };
    if (action !== "status") {
      const revision = rawRevision === undefined ? (await client.call<UpdateStatus>("desktop.update.status", { installationId: id })).revision : Number(rawRevision);
      Object.assign(params, { expectRevision: revision, requestId: rawRequest ?? randomUUID() });
      if (action === "restart") params.version = version;
      if (action === "configure") params.autoDownload = auto === "on";
    }
    const status = await client.call<UpdateStatus>(op, params);
    return { code: 0, err: "", out: flags["--json"] ? JSON.stringify(status) : `Desktop ${status.current}: ${status.phase}${status.target ? ` → ${status.target}` : ""}\nInstallation: ${status.installationId} · revision ${status.revision}${status.error ? `\n${status.error.message}` : ""}` };
  } catch (error) { return fail(error instanceof Error ? error.message : "service request failed"); }
  finally { client?.close(); }
}
export const COMMANDS: Command[] = [{ name: "desktop-update", usage: DESKTOP_UPDATE_USAGE, run: desktopUpdateCommand }];
