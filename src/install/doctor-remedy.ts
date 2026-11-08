import { raisedByPacer } from "../core/errors";
import type { Check, Remedy } from "./doctor";

/**
 * Codes that mean pacer itself could not run a check, never the user's setup, when pacer raised them.
 * `plugin_timeout` counts because pacer raises it when its own plugin call misses a deadline.
 * A plugin's error reply carrying one of these codes is the plugin's failure.
 */
export const INTERNAL_ERROR_CODES: ReadonlySet<string> = new Set([
  "plugin_unavailable", "plugin_timeout", "plugin_refused", "unknown_plugin",
]);

export function isInternalCode(code: string | undefined): boolean {
  return code !== undefined && INTERNAL_ERROR_CODES.has(code);
}

export function internalErrorCode(error: unknown): string | undefined {
  return raisedByPacer(error) && isInternalCode(error.code) ? error.code : undefined;
}

/** A check pacer could not run: never a setup problem, and never a reinstall suggestion. */
export function internalCheck(check: Pick<Check, "name" | "detail">): Check {
  return { name: check.name, level: "warn", evidence: "unverified", detail: check.detail, remedy: remedies.internal() };
}

const PRIVACY_FILES = "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders";
/** Only confirmed account billing pages; other kinds offer "Turn off" alone. */
const BILLING: Record<string, string> = {
  claude: "https://claude.ai/settings/billing",
};

/** Remedies name registered operations only; params never carry consent, `consent: true` marks ops that need it. */
export const remedies = {
  refreshUsage: (account: string): Remedy => ({ kind: "auto", label: "Refresh usage", op: "limits.refresh", params: { account } }),
  signIn: (account: string, label: string): Remedy => ({ kind: "user", label: `Sign in to ${label}`, op: "account.signin", params: { name: account } }),
  billing: (accountKind: string, runner: string, label: string): Remedy => {
    const turnOff = { label: `Turn off ${label}`, op: "runner.block", params: { id: runner, reason: "No active subscription" } };
    const url = BILLING[accountKind];
    return url
      ? { kind: "user", label: `Open ${label} billing`, url, secondary: turnOff }
      : { kind: "user", ...turnOff };
  },
  updateFiles: (agent: string): Remedy => ({ kind: "auto", label: "Update files", op: "agent.connect", params: { agent }, consent: true }),
  review: (agent: string): Remedy => ({ kind: "review", label: "Review and fix", op: "agent.preview", params: { agent } }),
  service: (label: string): Remedy => ({ kind: "auto", label, op: "service.install", consent: true }),
  privacySettings: (): Remedy => ({ kind: "user", label: "Open Privacy settings", url: PRIVACY_FILES }),
  agent: (check: string): Remedy => ({ kind: "agent", label: "Fix with agent", op: "doctor.fix.delegate", params: { check, scope: "fix" } }),
  internal: (): Remedy => ({ kind: "internal", label: "Restart pacer service", op: "service.install", consent: true }),
};

/** Every warning or failure gets exactly one remedy; passed and informational checks get none. */
export function withRemedies(checks: Check[]): Check[] {
  return checks.map(check => {
    if (check.level !== "warn" && check.level !== "fail") {
      const { remedy: _remedy, ...rest } = check;
      return rest;
    }
    return check.remedy ? check : { ...check, remedy: remedies.agent(check.name) };
  });
}

const quote = (value: string) => /^[\w@%+=:,./#-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

/** The CLI command that performs a remedy, when one exists. */
export function remedyCommand(remedy: Remedy): string | undefined {
  const param = (key: string) => typeof remedy.params?.[key] === "string" ? remedy.params[key] as string : undefined;
  switch (remedy.op) {
    case "limits.refresh": return `pacer limits refresh${param("account") ? ` ${quote(param("account")!)}` : ""}`;
    case "service.install": return remedy.kind === "internal" ? "pacer service restart" : "pacer service install";
    case "agent.preview":
    case "agent.connect": return param("agent") ? `pacer install ${quote(param("agent")!)}` : undefined;
    case "runner.block": return param("id") ? `pacer executor block ${quote(param("id")!)}` : undefined;
    case "account.signin":
    case "doctor.fix.delegate": return `pacer api call ${remedy.op} --params ${quote(JSON.stringify(remedy.params ?? {}))}`;
  }
  return remedy.url ? `open ${quote(remedy.url)}` : undefined;
}
