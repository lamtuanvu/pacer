import { join } from "node:path";
import { readJson } from "../fsutil";
import type { Ctx } from "../types";
import type { Check } from "./doctor";

const settings = "Open System Settings > Privacy & Security > Files and Folders and allow Removable Volumes for pacer.";

/** Read only registry state; never resolve or stat a repository in this process. */
export async function removableVolumeChecks(ctx: Ctx, o: { platform?: string; paths?: string[]; binary?: string } = {}): Promise<Check[]> {
  if ((o.platform ?? process.platform) !== "darwin") return [];
  const registry = readJson<Record<string, {path?: string}>>(join(ctx.pacerHome, "state", "repos.json")) ?? {};
  const paths = [...new Set(o.paths ?? Object.values(registry).flatMap(r => typeof r?.path === "string" ? [r.path] : []))]
    .filter(path => /^\/Volumes\/[^/]+(?:\/|$)/.test(path));
  const checks: Check[] = [];
  for (const path of paths) {
    try {
      const r = await ctx.run(["/bin/ls", "-d", path], 3000);
      if (r.timedOut) {
        checks.push({name: "Removable volume access", level: "warn", detail: `${path}: timed out; permission is probably pending. Look for the macOS permission prompt.`, fix: settings});
      } else if (/EPERM|Operation not permitted/i.test(r.stderr)) {
        checks.push({name: "Removable volume access", level: "warn", detail: `${path}: access denied (${r.stderr.trim()})`, fix: settings});
      } else {
        checks.push({name: "Removable volume access", level: r.code === 0 ? "ok" : "warn", detail: `${path}: ${r.code === 0 ? "accessible" : r.stderr.trim() || `probe exited ${r.code}`}`});
      }
    } catch (e) {
      const error = String(e);
      const pending = /timeout|timed out|ETIMEDOUT|AbortError/i.test(error);
      checks.push({name: "Removable volume access", level: "warn", detail: `${path}: ${pending ? "permission is probably pending; look for the macOS prompt" : error}`, fix: settings});
    }
  }
  if (!paths.length) checks.push({name:"Removable volume access", level:"info", detail:"No registered repositories on removable volumes."});
  try {
    const binary = o.binary ?? ctx.which("pacer") ?? process.execPath;
    const r = await ctx.run(["/usr/bin/codesign", "-dv", binary], 3000);
    const adhoc = /Signature=adhoc/.test(r.stdout + r.stderr);
    checks.push({name:"macOS code signing", level:adhoc || r.code !== 0 || r.timedOut ? "warn" : "ok",
      detail:adhoc ? "Installed binary is ad hoc signed; each update can re-prompt for removable volumes until signed with a stable identity."
        : r.timedOut ? "Code-signing inspection timed out." : r.code !== 0 ? `Could not inspect installed binary: ${r.stderr.trim()}` : "Installed binary is not ad hoc signed.",
      ...(adhoc ? {fix:"For source builds, run bun scripts/sign-local.ts --create-identity, then bun run build and reinstall the signed build. Downloaded updates use the identity when available."} : {})});
  } catch (e) { checks.push({name:"macOS code signing", level:"warn", detail:`Could not inspect installed binary: ${String(e)}`}); }
  return checks;
}
