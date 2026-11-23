import type { AppGrant } from "./grants";

export type AppId = "orca";

/** Board no-grants fail reason: approval_required with nothing parseable to show. */
export const ORCA_NO_GRANTS_REASON =
  "Orca didn’t say what it would allow, so pacer won’t ask you to approve it here.";

/** One host app pacer can add itself to. */
export interface AppInfo {
  id: AppId;
  name: string;
  description: string;
  additions: string[];
  /** Download page when the host app is missing. */
  getUrl?: string;
}

export type AppPresence =
  | { kind: "missing_files"; reason: string }
  | { kind: "not_found" }
  | { kind: "ready"; hostVersion?: string; running?: boolean }
  | {
      kind: "added";
      hostVersion?: string;
      running?: boolean;
      installedVersion: string;
      bundledVersion?: string;
      updateAvailable: boolean;
    };

export interface AppStatus extends AppInfo {
  presence: AppPresence;
  /** Absolute path used for terminal fallback commands, when known. */
  panelDir: string | null;
  /** Retired marketplace plugin still listed in the host. */
  oldPlugin: boolean;
}

export type AppAddResult =
  | { status: "added"; id: AppId }
  | { status: "approval_required"; id: AppId; fingerprint: string; grants: AppGrant[]; stale?: boolean }
  | { status: "error"; id: AppId; error: string };

export type AppActionResult =
  | { ok: true; id: AppId }
  | { ok: false; id: AppId; error: string };
