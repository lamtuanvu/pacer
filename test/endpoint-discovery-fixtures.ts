/** Test-only fetch adapter for pure endpoint plugin behavior; never a runtime fallback. */
import { PluginError } from "@pacer/plugin";
import { discoverModels as pluginDiscover } from "../plugins/pacer-endpoints/models";
import type { Ctx } from "../src/types";
export type FakeDiscoveryFetch = (url: string, init?: RequestInit) => Promise<Response>;
export function discoveryFromFetch(request: FakeDiscoveryFetch = fetch) {
  return async (_ctx: Ctx, input: { baseUrl: string; key?: string | null; timeoutMs?: number }) => pluginDiscover({ http: async params => {
    const response = await request(params.url, { headers: input.key ? { Authorization: `Bearer ${input.key}` } : {} });
    const body = await response.text();
    if (input.key && body.includes(input.key)) throw new PluginError("capability_denied", "safe reflection refusal", undefined, "credential_reflection");
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body };
  } }, { baseUrl: input.baseUrl, keyRef: input.key ? "endpoint:test-owned" : null, timeoutMs: input.timeoutMs });
}
export const endpointDiscoveryDeps = (request: FakeDiscoveryFetch) => ({ fetch: request, discover: discoveryFromFetch(request) });
export function discoverModels({ fetch: request, ...input }: { baseUrl: string; key?: string | null; timeoutMs?: number; fetch?: FakeDiscoveryFetch }) {
  return discoveryFromFetch(request)({} as Ctx, input);
}
