import type { Handler, HostClient } from "@pacer/plugin";
import { dirname, join } from "node:path";
import { BUNDLED } from "../../../plugins/bundled";
import { pluginRegistry } from "../../../src/plugins";
import type { PluginRegistry } from "../../../src/plugins/registry";
import type { Ctx } from "../../../src/types";
import { createHandlers } from "../../../plugins/pacer-exec-orca/index";
import { manifest } from "../../../plugins/pacer-exec-orca/manifest";
import { createCallAuthority } from "../../../src/plugins/authority";
import type { OrcaExecutorCaller } from "../../../src/plugins/executor-orca";
import { answerCapability } from "../../../src/plugins/host";
import { EXTENSION_METHODS, manifestSchema } from "../../../src/plugins/protocol";

const wire = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;

/**
 * The bundled pacer-exec-orca handlers served in this process: each call gets a real host-issued call authority and
 * every capability call goes through the production host dispatcher, with JSON round trips as on the wire.
 */
export function inProcessOrca(options: { sleep?: (ms: number) => Promise<void>; calls?: string[];
  /** Simulate a provider that dies when it reaches this capability call. */ failOn?: string;
  /** Replace provider handlers, for example with a misbehaving provider. */ handlers?: Record<string, Handler>;
  /** Shorten the owning call's deadline to exercise cancellation. */ deadlineMs?: number } = {}): OrcaExecutorCaller {
  const parsed = manifestSchema.parse(manifest);
  const handlers = { ...createHandlers(options.sleep ? { sleep: options.sleep } : {}), ...options.handlers };
  return {
    async call(ctx, pluginId, method, params, call) {
      if (pluginId !== parsed.id) throw Error(`unexpected provider ${pluginId}`);
      const def = EXTENSION_METHODS[method]!;
      const input = def.params.parse(wire(params));
      const authority = createCallAuthority(ctx, call.resources, { deadlineMs: Date.now() + (options.deadlineMs ?? call.deadlineMs),
        grants: parsed.capabilities.map(capability => capability.name) });
      try {
        const host = { call: async (m: string, p: unknown) => {
          options.calls?.push(m);
          if (m === options.failOn) throw Error("plugin stdout closed");
          return wire(await answerCapability(ctx, { id: parsed.id, manifest: parsed }, m, wire(p), authority));
        } } as unknown as HostClient;
        return def.result.parse(wire(await handlers[method]!(input, host, authority.signal)));
      } finally { await authority.revoke(); }
    },
  };
}

/** Serve bundled plugins of this home as real child processes from source; shut them down with shutdownPlugins. */
export function sourcePluginRegistry(ctx: Ctx): PluginRegistry {
  const root = join(import.meta.dir, "..", "..", "..");
  return pluginRegistry(ctx, { bundled: BUNDLED, spawnBundled: (_ctx, id) => ({ argv: [process.execPath, join(root, "plugins", id, "index.ts")],
    cwd: root, env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` } }) });
}
