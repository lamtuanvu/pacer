#!/usr/bin/env bun
import { serve, type Handler, type PluginManifest } from "@pacer/plugin";

export const manifest: PluginManifest = {
  id: "pacer-remote-caller", version: "0.1.0", publisher: "pacer", host: "^1.5",
  contributes: { remoteCaller: {} }, capabilities: [{ name: "hosts" }], reentrant: true, tier: "free",
};

export const handlers: Record<string, Handler> = {
  "remoteCaller.fetch": async (raw, host) => {
    const request = raw as { alias: string; timeoutMs: number; maxBytes: number };
    const opened = await host.hosts!.open(request.alias);
    let failed = false;
    try {
      return await host.hosts!.fetch({ session: opened.session,
        timeoutMs: request.timeoutMs, maxBytes: request.maxBytes });
    } catch (error) { failed = true; throw error; }
    finally {
      // A retired lease may refuse close after a failed fetch. Preserve the
      // original failure so the caller can report the actual transfer error.
      if (failed) await host.hosts!.close(opened.session).catch(() => {});
      else await host.hosts!.close(opened.session);
    }
  },
  "remoteCaller.identity": async (raw, host) => {
    const request = raw as { alias: string; path: string; name: string; email: string };
    const opened = await host.hosts!.open(request.alias);
    try {
      return await host.hosts!.run({ session: opened.session, script: "SET_IDENTITY",
        args: [request.path, request.name, request.email], timeoutMs: 50_000, maxBytes: 65_536 });
    } finally { await host.hosts!.close(opened.session); }
  },
  "remoteCaller.questionRead": async (raw, host) => {
    const request = raw as { alias: string; path: string };
    const opened = await host.hosts!.open(request.alias);
    try { return await host.hosts!.run({ session: opened.session, script: "QUESTION",
      args: [request.path], timeoutMs: 20_000, maxBytes: 8192 }); }
    finally { await host.hosts!.close(opened.session); }
  },
  "remoteCaller.usageRead": async (raw, host) => {
    const request = raw as { alias: string; home?: string };
    const opened = await host.hosts!.open(request.alias);
    let failed = false;
    try { return await host.hosts!.run({ session: opened.session, script: "CODEX_USAGE",
      args: request.home ? [request.home] : [], timeoutMs: 60_000, maxBytes: 65_536 }); }
    catch (error) { failed = true; throw error; }
    finally {
      if (failed) await host.hosts!.close(opened.session).catch(() => {});
      else await host.hosts!.close(opened.session);
    }
  },
};

if (import.meta.main) await serve({ manifest, handlers });
