export interface DiscoveredModel { id: string; name?: string; context?: number; output?: number; tools?: boolean }
export type DiscoveryResult = {listed: true; models: DiscoveredModel[]} | {listed: false; error: string; detail: string};

/** Response bodies and transport errors may echo credentials; only return fixed diagnostics. */
export async function discoverModels({baseUrl, key, fetch: request = fetch, timeoutMs = 10000}: {
  baseUrl: string; key?: string | null; fetch?: (input: string, init?: RequestInit) => Promise<Response>; timeoutMs?: number;
}): Promise<DiscoveryResult> {
  const fail = (error: string, detail: string): DiscoveryResult => ({listed: false, error, detail});
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DiscoveryResult>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(fail("timeout", "Model discovery timed out.")); }, timeoutMs);
  });
  try {
    return await Promise.race([timeout, (async (): Promise<DiscoveryResult> => {
      try {
        const url = new URL(baseUrl);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return fail("invalid_url", "Check the URL and try again.");
        url.pathname = url.pathname.replace(/\/$/, "") + "/models";
        const response = await request(url.toString(), {signal: controller.signal, headers: key ? {Authorization: `Bearer ${key}`} : {}});
        if (response.status === 401 || response.status === 403) return fail("refused", "The key was refused.");
        if (response.status === 404) return fail("not_listed", "This endpoint doesn't list models. Enter model ids.");
        if (!response.ok) return fail("http_error", `Model discovery failed (HTTP ${response.status}).`);
        let body;
        try { body = await response.json(); } catch { return fail("invalid_response", "The endpoint returned an invalid model list."); }
        const entries = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : null;
        if (!entries) return fail("not_listed", "This endpoint doesn't list models. Enter model ids.");
        const positive = (...values: unknown[]) => values.find(v => typeof v === "number" && Number.isSafeInteger(v) && v > 0) as number | undefined;
        const models: DiscoveredModel[] = [];
        for (const item of entries) {
          if (!item || typeof item !== "object") continue;
          const id = item.id ?? item.model ?? item.name;
          if (typeof id !== "string" || !id.trim() || models.some(m => m.id === id)) continue;
          const name = item.display_name ?? item.name;
          const context = positive(item.context_length, item.max_model_len, item.max_context_length, item.context_window,
            ...Object.entries(item.model_info ?? {}).filter(([k]) => k.endsWith(".context_length")).map(([,v]) => v));
          const output = positive(item.max_output_tokens, item.max_completion_tokens, item.output_length);
          models.push({id, ...(typeof name === "string" ? {name} : {}), ...(context ? {context} : {}), ...(output ? {output} : {}), ...(typeof item.tools === "boolean" ? {tools: item.tools} : {})});
        }
        // Some servers echo authentication material in a malformed model entry.
        if (key && JSON.stringify(models).includes(key)) return fail("invalid_response", "The endpoint returned an invalid model list.");
        return {listed: true, models};
      } catch { return fail("unreachable", "Endpoint unreachable. Check the URL and try again."); }
    })()]);
  } finally { clearTimeout(timer); }
}
