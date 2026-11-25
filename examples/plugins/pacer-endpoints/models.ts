import { PluginError } from '@pacer/plugin';
import type { HostClient } from "@pacer/plugin";

export interface DiscoveredModel {
  id: string;
  name?: string;
  context?: number;
  output?: number;
  tools?: boolean;
}
export type DiscoveryResult =
  | { listed: true; models: DiscoveredModel[] }
  | { listed: false; error: string; detail: string };
export interface DiscoveryInput {
  baseUrl: string;
  keyRef?: string | null;
  timeoutMs?: number;
}

/** Credentials remain host-owned; transport errors/bodies are never diagnostics. */
export async function discoverModels(
  host: Pick<HostClient, "http">,
  { baseUrl, keyRef, timeoutMs = 10000 }: DiscoveryInput,
): Promise<DiscoveryResult> {
  const fail = (error: string, detail: string): DiscoveryResult => ({ listed: false, error, detail });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DiscoveryResult>(resolve => {
    timer = setTimeout(() => resolve(fail("timeout", "Model discovery timed out.")), timeoutMs);
  });
  try {
    return await Promise.race([timeout, (async (): Promise<DiscoveryResult> => {
      try {
        const url = new URL(baseUrl);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
          return fail("invalid_url", "Check the URL and try again.");
        }
        url.pathname = url.pathname.replace(/\/$/, "") + "/models";
        const response = await host.http({
          url: url.toString(), method: "GET", timeoutMs,
          ...(keyRef ? { authorization: { secretRef: keyRef } } : {}),
        });
        if (response.status === 401 || response.status === 403) return fail("refused", "The key was refused.");
        if (response.status === 404) return fail("not_listed", "This endpoint doesn't list models. Enter model ids.");
        if (response.status < 200 || response.status >= 300) return fail("http_error", `Model discovery failed (HTTP ${response.status}).`);
        let body;
        try {
          // Response.json strips one initial UTF-8 BOM; host.http returns text.
          body = JSON.parse(response.body.replace(/^\uFEFF/, ""));
        } catch { return fail("invalid_response", "The endpoint returned an invalid model list."); }
        const entries = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : null;
        if (!entries) return fail("not_listed", "This endpoint doesn't list models. Enter model ids.");
        const positive = (...values: unknown[]) => values.find(value => typeof value === "number" && Number.isSafeInteger(value) && value > 0) as number | undefined;
        const models: DiscoveredModel[] = [];
        for (const item of entries) {
          if (!item || typeof item !== "object") continue;
          const id = item.id ?? item.model ?? item.name;
          if (typeof id !== "string" || !id.trim() || models.some(model => model.id === id)) continue;
          const name = item.display_name ?? item.name;
          const context = positive(item.context_length, item.max_model_len, item.max_context_length, item.context_window,
            ...Object.entries(item.model_info ?? {}).filter(([key]) => key.endsWith(".context_length")).map(([, value]) => value));
          const output = positive(item.max_output_tokens, item.max_completion_tokens, item.output_length);
          models.push({ id, ...(typeof name === "string" ? { name } : {}), ...(context ? { context } : {}),
            ...(output ? { output } : {}), ...(typeof item.tools === "boolean" ? { tools: item.tools } : {}) });
        }
        // Resolved-key reflection refusal belongs to the host before response delivery.
        return { listed: true, models };
      } catch (error) {
        if (error instanceof PluginError && error.code === 'capability_denied' && error.reason === 'credential_reflection') {
          return fail('invalid_response', 'The endpoint returned an invalid model list.');
        }
        return fail("unreachable", "Endpoint unreachable. Check the URL and try again.");
      }
    })()]);
  } finally { clearTimeout(timer); }
}
