import { serve } from "../../../packages/plugin-sdk/src";
await serve({ manifest: { id: "large-result-fixture", version: "0.2.0", publisher: "test", host: "^1.1", contributes: { usage: {} }, capabilities: [] },
  handlers: { "usage.read": async (params: any) => ({ windows: [], capturedAt: 100, stale: false,
    alternatives: [{ windows: [], capturedAt: 99, stale: true, futureNested: { payload: "界".repeat(params.characters ?? 500000) } }], futureTop: "retained" }) } });
