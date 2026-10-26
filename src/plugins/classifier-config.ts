import { createHash } from "node:crypto";
import type { ClassifierConfig } from "../config/classifier";
import type { AdapterId } from "../classify/types";

export interface ClassifierSnapshot {
  readonly config: Readonly<Record<string, string | number | null>>;
  readonly hosts: readonly string[];
  readonly external: boolean;
  readonly secretAliases?: Readonly<Record<string, string>>;
}
function local(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host.endsWith(".localhost")
  );
}
/** Project a validated configuration, never the environment or resolved credentials. */
export function classifierSnapshot(
  cfg: ClassifierConfig,
  adapter: AdapterId,
): ClassifierSnapshot {
  const aliases: Record<string, string> = Object.create(null);
  const reference = (name: string): string => {
    if (/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name)) return `secrets:${name}`;
    const alias = `pacer_ref_${createHash("sha256").update(name).digest("hex")}`;
    aliases[alias] = name;
    return `secrets:${alias}`;
  };
  let config: Record<string, string | number | null> = {};
  let hosts: string[] = [];
  let external = false;
  if (adapter === "ollama") {
    const value = cfg.adapters.ollama;
    config = {
      baseUrl: value.baseUrl,
      model: value.model,
      maxTokens: value.maxTokens,
      keyRef: value.keyEnv ? reference(value.keyEnv) : null,
    };
    hosts = [new URL(value.baseUrl).hostname];
    external = !local(hosts[0]);
  } else if (adapter === "jev") {
    const value = cfg.adapters.jev;
    config = {
      baseUrl: value.baseUrl,
      model: value.model,
      keyRef: reference(value.keyEnv),
      usdPerMtokIn: value.usdPerMtokIn,
      usdPerMtokOut: value.usdPerMtokOut,
    };
    hosts = [new URL(value.baseUrl).hostname];
    external = true;
  }
  return Object.freeze({
    config: Object.freeze(config),
    hosts: Object.freeze(hosts),
    external,
    ...(Object.keys(aliases).length
      ? { secretAliases: Object.freeze(aliases) }
      : {}),
  });
}
export function classifierPluginConfig(cfg: ClassifierConfig) {
  return Object.freeze({
    adapters: Object.freeze({
      rules: classifierSnapshot(cfg, "rules").config,
      ollama: classifierSnapshot(cfg, "ollama").config,
      jev: classifierSnapshot(cfg, "jev").config,
    }),
  });
}
