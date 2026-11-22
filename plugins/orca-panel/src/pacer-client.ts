// A pure pacer HTTP/SSE client: plain Node/Bun, no Orca imports, so it can be unit-tested
// with plain `bun test` independent of the Orca plugin harness. Auth is the same bearer
// token the CLI/TUI/app use (`$PACER_HOME/token`, mode 0600) against the loopback service
// on `$PACER_PORT` or the built-in default 4317 (`src/serve/constants.ts: DEFAULT_PORT`).
/// <reference types="@types/bun" />
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type PacerEndpoint = { baseUrl: string; token: string };

const DEFAULT_PORT = 4317;

export type AttentionAction = {
  label: string;
  op: string;
  params: Record<string, unknown>;
  style?: "primary" | "danger";
  /** Wire confirm text from the service (`src/attention/types.ts`); shown as-is in the panel. */
  confirm?: string;
};

/**
 * Field names from docs/protocol.md's "Attention and actions" section, kept to the ones this
 * plugin uses. `repo` is widened to optional-or-null here (the doc lists it without `?` and
 * doesn't specify its shape at all): a global/unscoped item (e.g. `kind: "setup"`) sends `repo:
 * null`, and when present it is the service's own `RepoRef` (src/attention/types.ts,
 * src/api/read-model/types.ts) - the same `{ key, path, label }` shape as
 * `PacerSnapshot.repos[]`'s entries, not a bare repo key string (an earlier, untested
 * assumption, confirmed wrong against a real `/v3/snapshot` response). `unreachable`/
 * `identityUnverified` exist on the real type but this plugin doesn't branch on them.
 * `executor`/`host`/`account` are kept for completeness even though v1's generic row rendering
 * doesn't branch on them either.
 */
export type AttentionItem = {
  id: string;
  kind: string;
  severity: "blocked" | "problem" | "decide";
  repo?: { key: string; path: string; label: string } | null;
  taskId?: string;
  executor?: string;
  host?: string;
  account?: string;
  title: string;
  detail: string;
  raisedAt: number;
  since: number;
  actions: AttentionAction[];
  /** Wire notify policy (`src/attention/types.ts`), not a boolean. */
  notify: "important" | "all";
  snoozedUntil?: number;
};

/** Planner meter fields the worker trims into the panel snapshot. */
export type PacerPlanner = {
  runner?: string;
  agent: string;
  usedPct: number | null;
  pacePct: number | null;
  verdict: string;
  advice: string;
  mode: string;
  modeHeldUntil?: number;
  resetsAt: number | null;
  window: string | null;
  stale: boolean;
};

export type PacerPause = { until: number | null; reason: string | null; by: string | null };

export type PacerExecutor = {
  id: string;
  agent: string;
  account: string;
  rank: number | "planner";
  state: string;
  tone: string;
  sub: string;
  reason?: string;
  next: boolean;
  slots: { used: number; max: number };
  enabled: boolean;
  untested?: true;
};

/** Task fields the panel lists need; trimmed further when building PanelSnapshot. */
export type PacerTask = {
  id: string;
  rev: number;
  title: string;
  state: string;
  repo: { key: string; path: string; label: string } | null;
  executor?: string | null;
  progress?: { phase?: string } | null;
  attemptStartedAt?: number;
  updatedAt: number;
  review?: { accepted: boolean } | null;
  reviewRequest?: unknown;
  acceptanceState?: string;
  resolved?: string | null;
  retriedBy?: string | null;
  liveness?: { stalled: boolean; reason: string; since: number } | null;
  worktree?: string | null;
  source?: string;
  dismissed?: boolean;
  activeAgentSessions?: number;
};

/** The subset of the real snapshot's fields this plugin uses. */
export type PacerSnapshot = {
  seq: number;
  at: number;
  planner: PacerPlanner | null;
  counts: unknown;
  pause: PacerPause | null;
  today: { since: number } | null;
  attention: AttentionItem[];
  repos: { key: string; label: string; path: string }[];
  tasks: PacerTask[];
  executors: PacerExecutor[];
};

/** Read `$PACER_HOME/token` (default `~/.pacer/token`) and build the loopback base URL from `$PACER_PORT` or the default port. Returns null when the token file is missing/unreadable; never throws. */
export function readPacerEndpoint(env: Record<string, string | undefined> = process.env): PacerEndpoint | null {
  const home = env.PACER_HOME || join(homedir(), ".pacer");
  try {
    const token = readFileSync(join(home, "token"), "utf8").trim();
    if (!token) return null;
    const port = env.PACER_PORT || String(DEFAULT_PORT);
    return { baseUrl: `http://127.0.0.1:${port}`, token };
  } catch {
    return null;
  }
}

function authHeaders(endpoint: PacerEndpoint): HeadersInit {
  return { authorization: `Bearer ${endpoint.token}` };
}

/** Error message from a pacer error body (`{ error: { message } }`), or a fallback string. */
function errorText(body: unknown, status: number): string {
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === "string" && message ? message : `HTTP ${status}`;
}

/** `GET /v3/snapshot`. Returns `{ error }` instead of throwing on a failed request or a non-2xx response. */
export async function getSnapshot(endpoint: PacerEndpoint): Promise<PacerSnapshot | { error: string }> {
  let response: Response;
  try {
    response = await fetch(`${endpoint.baseUrl}/v3/snapshot`, {
      headers: authHeaders(endpoint),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch {
    return { error: "pacer is unreachable" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return response.ok ? { error: `invalid snapshot response (HTTP ${response.status})` } : { error: errorText(null, response.status) };
  }
  if (!response.ok) return { error: errorText(body, response.status) };
  // The wire response is `{ protocol, seq, snapshot }` (docs/protocol.md "HTTP routes"); the
  // fields this type cares about live under `snapshot`, not the envelope.
  const envelope = body as { seq?: unknown; snapshot?: Partial<PacerSnapshot> } | null;
  const snapshot = envelope?.snapshot;
  const seq = typeof envelope?.seq === "number" ? envelope.seq : snapshot?.seq;
  if (!snapshot || typeof seq !== "number" || !Array.isArray(snapshot.attention) || !Array.isArray(snapshot.repos)) {
    return { error: "invalid snapshot response" };
  }
  const raw = snapshot as Partial<PacerSnapshot> & { at?: unknown; pause?: PacerPause | null; today?: { since: number } | null; tasks?: PacerTask[]; executors?: PacerExecutor[] };
  const at = typeof raw.at === "number" ? raw.at : Math.floor(Date.now() / 1000);
  return {
    seq,
    at,
    planner: (raw.planner as PacerPlanner | null | undefined) ?? null,
    counts: raw.counts,
    pause: raw.pause ?? null,
    today: raw.today ?? null,
    attention: raw.attention as AttentionItem[],
    repos: raw.repos as { key: string; label: string; path: string }[],
    tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
    executors: Array.isArray(raw.executors) ? raw.executors : [],
  };
}

/** `POST /v3/ops/<op>` with `params` as the JSON body. Returns the wrapped op result or an error, never throws. */
export async function callOp(
  endpoint: PacerEndpoint,
  op: string,
  params: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string; conflict?: true }> {
  let response: Response;
  try {
    response = await fetch(`${endpoint.baseUrl}/v3/ops/${encodeURIComponent(op)}`, {
      method: "POST",
      headers: { ...authHeaders(endpoint), "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch {
    return { ok: false, error: "pacer is unreachable" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: `HTTP ${response.status}` };
  }
  if (!response.ok) {
    const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
    const conflict = response.status === 409 || code === "conflict";
    return conflict
      ? { ok: false, error: errorText(body, response.status), conflict: true }
      : { ok: false, error: errorText(body, response.status) };
  }
  const result = (body as { result?: unknown } | null)?.result;
  if (result === undefined) return { ok: false, error: "missing op result" };
  return { ok: true, result };
}

/**
 * `GET /v3/events?since=<since>` as a streamed fetch. Hand-parses Server-Sent-Event frames
 * (`id:`/`event:`/`data:` lines separated by blank lines; comment lines starting `:` are
 * ignored) — no `eventsource` npm dependency. Calls `onEvent` per event and `onDrop` once
 * when the stream ends or errors (the caller reconnects with backoff from the last seq it
 * saw). Returns an abort function; aborting does not fire `onDrop`.
 */
export function subscribeEvents(
  endpoint: PacerEndpoint,
  since: number,
  onEvent: (seq: number, type: string, data: unknown) => void,
  onDrop: () => void,
): () => void {
  const controller = new AbortController();
  let stopped = false;
  let dropped = false;
  const drop = () => {
    if (!dropped && !stopped) {
      dropped = true;
      onDrop();
    }
  };

  const parseBlock = (block: string): void => {
    let seq: number | null = null;
    let type = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith(":") || line.trim() === "") continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "id") {
        const parsed = Number(value);
        seq = Number.isSafeInteger(parsed) ? parsed : null;
      } else if (field === "event") {
        type = value || "message";
      } else if (field === "data") {
        data = data ? `${data}\n${value}` : value;
      }
    }
    if (seq === null || data === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      parsed = data;
    }
    onEvent(seq, type, parsed);
  };

  void (async () => {
    try {
      const response = await fetch(`${endpoint.baseUrl}/v3/events?since=${since}`, {
        headers: authHeaders(endpoint),
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok || !response.body) {
        drop();
        return;
      }
      const decoder = new TextDecoder();
      let buffer = "";
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (stopped) return;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep = buffer.indexOf("\n\n");
        while (sep !== -1) {
          parseBlock(buffer.slice(0, sep));
          buffer = buffer.slice(sep + 2);
          sep = buffer.indexOf("\n\n");
        }
      }
      buffer += decoder.decode();
      if (buffer.trim() !== "") parseBlock(buffer);
      drop();
    } catch {
      drop();
    }
  })();

  return () => {
    if (stopped) return;
    stopped = true;
    controller.abort();
  };
}
