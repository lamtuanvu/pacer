import { PluginError, type HostClient } from "@pacer/plugin";

export type Question =
  | { type: "choice"; id: string; instructions: string; criteria: Record<string, string> }
  | { type: "score"; id: string; instructions: string; min: number; max: number }
  | { type: "yesno"; id: string; instructions: string };
export interface Answer {
  value: string | number | boolean;
  probabilities?: Record<string, number>;
  confidence: number;
  latencyMs: number;
  costUsd?: number;
}
export interface Classifier {
  id: string;
  external: boolean;
  ask(state: string, question: Question, timeoutMs: number): Promise<Answer>;
}
export type ClassifierHost = Pick<HostClient, "http" | "secrets">;

export class HttpError extends PluginError {
  readonly body: string;
  constructor(readonly status: number, body: string, authenticated: boolean) {
    super("invalid_input", authenticated ? `HTTP ${status}` : `HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = "HttpError";
    this.body = authenticated ? "" : body;
  }
}

/** Provider interpretation uses the per-handler SDK client, never ambient fetch. */
export async function postJson<T = unknown>(
  host: ClassifierHost, url: string, body: unknown,
  options: { timeoutMs: number; keyRef?: string },
): Promise<T> {
  const response = await host.http({
    url, method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), timeoutMs: options.timeoutMs,
    ...(options.keyRef ? { authorization: { secretRef: options.keyRef } } : {}),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new HttpError(response.status, response.body, options.keyRef !== undefined);
  }
  return JSON.parse(response.body) as T;
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
export function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
  } catch { return false; }
}
