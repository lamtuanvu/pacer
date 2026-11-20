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
  confirm?: { title: string; body: string };
};

/** Field names copied verbatim from docs/protocol.md's "Attention and actions" section. */
export type AttentionItem = {
  id: string;
  kind: string;
  severity: "blocked" | "problem" | "decide";
  repo?: string;
  taskId?: string;
  title: string;
  detail: string;
  raisedAt: number;
  since: number;
  actions: AttentionAction[];
  notify: boolean;
  snoozedUntil?: number;
};

/** The subset of the real snapshot's fields this plugin uses; `planner`/`counts` stay unknown. */
export type PacerSnapshot = {
  seq: number;
  planner: unknown;
  counts: unknown;
  attention: AttentionItem[];
  repos: { key: string; label: string; path: string }[];
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
  const snapshot = body as Partial<PacerSnapshot> | null;
  if (!snapshot || typeof snapshot.seq !== "number" || !Array.isArray(snapshot.attention) || !Array.isArray(snapshot.repos)) {
    return { error: "invalid snapshot response" };
  }
  return {
    seq: snapshot.seq,
    planner: snapshot.planner,
    counts: snapshot.counts,
    attention: snapshot.attention as AttentionItem[],
    repos: snapshot.repos as { key: string; label: string; path: string }[],
  };
}

/** `POST /v3/ops/<op>` with `params` as the JSON body. Returns the wrapped op result or an error, never throws. */
export async function callOp(
  endpoint: PacerEndpoint,
  op: string,
  params: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await fetch(`${endpoint.baseUrl}/v3/ops/${op}`, {
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
  if (!response.ok) return { ok: false, error: errorText(body, response.status) };
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
