import type { AppGrant } from "../apps/grants";
import { ORCA_NO_GRANTS_REASON, type AppStatus } from "../apps/types";

/** UI phase for one Apps card; decided only from the service status + local approve/error state. */
export type AppsCardPhase =
  | "missing_files"
  | "not_found"
  | "ready"
  | "approving"
  | "added"
  | "update"
  | "failed";

export interface AppsCardView {
  id: string;
  name: string;
  description: string;
  additions: string[];
  phase: AppsCardPhase;
  hostVersion?: string;
  pill?: { label: string; tone: "neutral" | "good" | "warn" | "bad" };
  cardTone?: "warn" | "bad";
  whereToFind?: string;
  getUrl?: string;
  updateLabel?: string;
  error?: string;
  grants?: AppGrant[];
  fingerprint?: string;
  /** Board expired status: re-shown grants after approval_stale. */
  expired?: boolean;
  oldPlugin: boolean;
  panelDir: string | null;
  terminalCommands?: { install: string; approve: string };
}

export interface AppsPageView {
  availableLabel: string;
  cards: AppsCardView[];
  trustCaption: string;
}

const WHERE_TO_FIND =
  'In Orca: the right sidebar, under Pacer (the gauge icon). The status bar shows your pace and what needs you in this repo, for example "pacer 17% · 3".';

const TRUST =
  "pacer adds itself to an app only after you confirm what that app will allow, and only changes its own part of that app. Removing it takes pacer out and leaves the rest as it was.";

export interface AppsCardLocalState {
  /** Pending approval from the last apps.add / apps.update without approve. */
  approval?: { fingerprint: string; grants: AppGrant[]; stale?: boolean };
  /** Last hard failure message (couldn't add). */
  error?: string;
}

function failedCard(base: AppsCardView, app: AppStatus, error: string): AppsCardView {
  return {
    ...base,
    phase: "failed",
    hostVersion: presenceHost(app),
    pill: { label: "Couldn't add", tone: "bad" },
    cardTone: "bad",
    error,
    ...(app.panelDir
      ? {
          terminalCommands: {
            install: `orca plugin install ${JSON.stringify(app.panelDir)}`,
            approve: `orca plugin install ${JSON.stringify(app.panelDir)} --approve <fingerprint>`,
          },
        }
      : {}),
  };
}

/** Pure card view for Settings › Apps; keeps every board decision out of the Preact tree. */
export function appsCardView(app: AppStatus, local: AppsCardLocalState = {}): AppsCardView {
  const base: AppsCardView = {
    id: app.id,
    name: app.name,
    description: app.description,
    additions: app.additions,
    phase: "ready",
    oldPlugin: app.oldPlugin,
    panelDir: app.panelDir,
    ...(app.getUrl ? { getUrl: app.getUrl } : {}),
  };

  if (local.approval) {
    if (!local.approval.grants.length) {
      return failedCard(base, app, ORCA_NO_GRANTS_REASON);
    }
    return {
      ...base,
      phase: "approving",
      hostVersion: presenceHost(app),
      grants: local.approval.grants,
      fingerprint: local.approval.fingerprint,
      ...(local.approval.stale ? { expired: true } : {}),
    };
  }

  if (local.error) {
    return failedCard(base, app, local.error);
  }

  switch (app.presence.kind) {
    case "missing_files":
      return {
        ...base,
        phase: "missing_files",
        pill: { label: "Not available", tone: "neutral" },
        error: app.presence.reason,
      };
    case "not_found":
      return {
        ...base,
        phase: "not_found",
        pill: { label: "Not found", tone: "neutral" },
      };
    case "ready":
      return {
        ...base,
        phase: "ready",
        ...(app.presence.hostVersion ? { hostVersion: app.presence.hostVersion } : {}),
      };
    case "added": {
      if (app.presence.updateAvailable && app.presence.bundledVersion) {
        return {
          ...base,
          phase: "update",
          hostVersion: app.presence.hostVersion,
          whereToFind: WHERE_TO_FIND,
          pill: { label: "Update available", tone: "warn" },
          cardTone: "warn",
          updateLabel: `Update to ${app.presence.bundledVersion}`,
        };
      }
      return {
        ...base,
        phase: "added",
        hostVersion: app.presence.hostVersion,
        whereToFind: WHERE_TO_FIND,
        pill: { label: `Added · ${app.presence.installedVersion}`, tone: "good" },
      };
    }
  }
}

function presenceHost(app: AppStatus): string | undefined {
  if (app.presence.kind === "ready" || app.presence.kind === "added") return app.presence.hostVersion;
  return undefined;
}

export function appsPageView(apps: AppStatus[], localById: Record<string, AppsCardLocalState> = {}): AppsPageView {
  return {
    availableLabel: `Available · ${apps.length}`,
    cards: apps.map((app) => appsCardView(app, localById[app.id])),
    trustCaption: TRUST,
  };
}

/** A card's visible state, as far as focus is concerned: a change means the pressed control was replaced. */
export function appsCardFocusKey(card: Pick<AppsCardView, "phase" | "expired">): string {
  return `${card.phase}:${card.expired ? 1 : 0}`;
}

/** Move focus into a card after its state changed only when focus was in that card or lost to the page
 *  body: a keyboard or screen-reader user then lands on what the new state says, and focus is never
 *  pulled away from something elsewhere on the page. */
export function appsCardShouldMoveFocus(previousKey: string, nextKey: string, focus: "inside" | "body" | "elsewhere"): boolean {
  return previousKey !== nextKey && focus !== "elsewhere";
}
