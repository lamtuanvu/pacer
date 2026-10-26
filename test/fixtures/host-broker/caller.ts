#!/usr/bin/env bun
import { serve, type PluginManifest } from "@pacer/plugin";
import { appendFileSync } from "node:fs";

const manifest: PluginManifest = {
  id: "host-broker-caller", version: "1.0.0", publisher: "pacer", host: "^1.5",
  contributes: {}, capabilities: [{ name: "hosts" }], reentrant: true,
};

await serve({ manifest, handlers: {
  "diagnostic.ping": async (input, host) => {
    const request = input as { alias?: string; session?: string; mode?: string; timeoutMs?: number;
      maxBytes?: number; fetchExtra?: Record<string, unknown> };
    if (request.session) {
      await host.hosts!.run({ session: request.session, script: "PROBE", args: [], timeoutMs: 1000, maxBytes: 1024 });
      return { ok: true, uptimeS: 0 };
    }
    const alias = request.alias ?? "box";
    const opened = await host.hosts!.open(alias);
    if (request.mode === "fetch") {
      const fetched = await host.hosts!.fetch({ session: opened.session,
        timeoutMs: request.timeoutMs ?? 5000, maxBytes: request.maxBytes ?? 16, ...request.fetchExtra });
      await host.hosts!.close(opened.session);
      return { ok: true, uptimeS: 0, fetched };
    }
    if (request.mode === "identity") {
      const identity = await host.hosts!.run({ session: opened.session, script: "SET_IDENTITY",
        args: ["/remote/repo", "Example", "example@example.invalid"], timeoutMs: 1000, maxBytes: 1024 });
      await host.hosts!.close(opened.session);
      return { ok: true, uptimeS: 0, identity };
    }
    const result = await host.hosts!.run({ session: opened.session, script: "PROBE",
      args: [], timeoutMs: 1000, maxBytes: 1024 });
    await host.hosts!.close(opened.session);
    appendFileSync("broker-receipt.jsonl", JSON.stringify({ alias, output: result.stdout, code: result.code }) + "\n", { mode: 0o600 });
    return { ok: true, uptimeS: 0, output: result.stdout, session: opened.session };
  },
} });
