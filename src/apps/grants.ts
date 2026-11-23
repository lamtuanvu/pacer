/** Map Orca capability / execution kinds to the Settings › Apps board wording. */

export interface AppGrant {
  /** Orca's kind (`trusted-worker`, `storage:own`, …) or `execution:<profile>`. */
  kind: string;
  /** Plain-words title shown on the board. */
  what: string;
  /** One-line reason, or Orca's own description for unknown kinds. */
  why: string;
  /** Orca's own description when present (always kept; never hidden). */
  description?: string;
  /** Board SVG path for the grant row icon. */
  icon: string;
}

const KNOWN: Record<string, { what: string; why: string; icon: string }> = {
  "trusted-worker": {
    what: "Run its own code on this Mac, with your account’s access",
    why: "The panel’s worker talks to pacer and keeps the panel live.",
    icon: "M4 5h16v14H4zM8 10l3 2-3 2",
  },
  "storage:own": {
    what: "Keep its own small storage",
    why: "Where it last caught up with pacer.",
    icon: "M4 7h16M4 12h16M4 17h10",
  },
  "workspace:read": {
    what: "See your Orca projects and workspaces",
    why: "To show the repo of the worktree you’re in.",
    icon: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  },
  "workspace:write": {
    // Every power Orca lists for workspace:write, so the plain words never understate the grant.
    what: "Open and rename your workspaces, hide or show projects, focus their terminals, open their files and run Orca commands",
    why: "pacer only opens a task’s worktree when you press Open worktree or Open in Orca.",
    icon: "M7 17L17 7M9 7h8v8",
  },
};

const FALLBACK_ICON = "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m0 8v5m0-8.5v.5";

/** Turn one Orca grant kind (+ optional description) into board copy. Unknown kinds keep Orca's description. */
export function grantWords(kind: string, description?: string): AppGrant {
  const known = KNOWN[kind];
  if (known) {
    return {
      kind,
      what: known.what,
      why: known.why,
      ...(description ? { description } : {}),
      icon: known.icon,
    };
  }
  // An unknown kind has no reason pacer can vouch for: show Orca's words once, with no "why" line.
  const text = description?.trim() || kind;
  return { kind, what: text, why: "", ...(description ? { description } : {}), icon: FALLBACK_ICON };
}

/** Flatten Orca's approval `grants` object into the ordered board list (execution first, then capabilities). */
export function grantsFromOrcaApproval(grants: unknown): AppGrant[] {
  if (!grants || typeof grants !== "object") return [];
  const g = grants as {
    execution?: string;
    executionDescription?: string;
    capabilities?: Array<{ kind?: string; description?: string }>;
  };
  const out: AppGrant[] = [];
  if (typeof g.execution === "string" && g.execution) {
    out.push(grantWords(g.execution, typeof g.executionDescription === "string" ? g.executionDescription : undefined));
  }
  for (const cap of Array.isArray(g.capabilities) ? g.capabilities : []) {
    if (typeof cap?.kind === "string" && cap.kind) {
      out.push(grantWords(cap.kind, typeof cap.description === "string" ? cap.description : undefined));
    }
  }
  return out;
}
