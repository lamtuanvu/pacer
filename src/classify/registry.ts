import type { ClassifierConfig } from "../config/classifier";
import type { Ctx } from "../types";
import { jevClassifier } from "./jev";
import { ollamaClassifier } from "./ollama";
import { rulesClassifier } from "./rules";
import { secret } from "./secrets";
import type { AdapterId, Classifier } from "./types";

export type AdapterSet = Record<AdapterId, Classifier>;

export function buildAdapters(ctx: Ctx, cfg: ClassifierConfig, timeoutMs: number): AdapterSet {
  const local = cfg.adapters.ollama;
  const jev = cfg.adapters.jev;
  const apiKey = local.keyEnv ? secret(ctx, local.keyEnv) ?? undefined : undefined;
  return {
    rules: rulesClassifier,
    ollama: ollamaClassifier({ ...local, timeoutMs, apiKey }),
    jev: jevClassifier({ ...jev, timeoutMs, keyName: jev.keyEnv, apiKey: () => secret(ctx, jev.keyEnv) }),
  };
}
