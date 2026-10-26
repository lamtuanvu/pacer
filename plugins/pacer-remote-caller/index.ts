#!/usr/bin/env bun
import { serve, type Handler, type PluginManifest } from "@pacer/plugin";

export const manifest: PluginManifest = {
  id: "pacer-remote-caller", version: "0.1.0", publisher: "pacer", host: "^1.5",
  contributes: { remoteCaller: {} }, capabilities: [{ name: "hosts" }], reentrant: true, tier: "free",
};

export const handlers: Record<string, Handler> = {
  "remoteCaller.identity": async (raw, host) => {
    const request = raw as { alias: string; path: string; name: string; email: string };
    const opened = await host.hosts!.open(request.alias);
    try {
      return await host.hosts!.run({ session: opened.session, script: "SET_IDENTITY",
        args: [request.path, request.name, request.email], timeoutMs: 50_000, maxBytes: 65_536 });
    } finally { await host.hosts!.close(opened.session); }
  },
};

if (import.meta.main) await serve({ manifest, handlers });
