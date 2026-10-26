import type { ClassifierConfig } from "../config/classifier";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { pluginRegistry } from "../plugins";
import { classifierSnapshot } from "../plugins/classifier-config";
import { answerSchema } from "../plugins/classifier-protocol";
import { ADAPTER_IDS, type AdapterId, type Classifier } from "./types";

export type AdapterSet = Record<AdapterId, Classifier>;

/** Decision policy stays in the host; every answer comes from an enabled plugin. */
export function buildAdapters(ctx: Ctx, cfg: ClassifierConfig, timeoutMs: number): AdapterSet {
  const captured = structuredClone(cfg);
  return Object.fromEntries(ADAPTER_IDS.map(adapter => {
    const snapshot = classifierSnapshot(captured, adapter);
    const proxy: Classifier = {
      id: adapter,
      external: snapshot.external,
      async ask(state, question) {
        const registry = pluginRegistry(ctx);
        const id = registry.find(ctx, "classifier", contribution =>
          Array.isArray(contribution.adapters) && contribution.adapters.includes(adapter));
        if (!id) throw new CoreError("plugin_unavailable", `no enabled plugin provides classifier ${adapter}`);
        const options = {
          deadlineMs: timeoutMs, classifierConfig: captured,
          resources: { reads: [], commands: [], stores: [], http: { hosts: [...snapshot.hosts] }, ...(snapshot.secretAliases ? { secretAliases: { ...snapshot.secretAliases } } : {}) },
        };
        const result = await registry.call(ctx, id, "classifier.ask", {
          adapter, state, question, timeoutMs, config: snapshot.config,
        }, options);
        const parsed = answerSchema.safeParse(result);
        if (!parsed.success) throw new CoreError("plugin_refused", "classifier returned an invalid answer");
        return parsed.data;
      },
    };
    return [adapter, proxy];
  })) as AdapterSet;
}
