import { renderBench, runBench } from "../classify/bench";
import { buildAdapters } from "../classify/registry";
import { ADAPTER_IDS, DECISIONS, type AdapterId, type DecisionName } from "../classify/types";
import { ClassifierConfigError, classifierConfig, validateClassifier } from "../config/classifier";
import { loadStrategy, MissingStrategyError, parseDuration, StrategyError } from "../config/strategy";
import type { Command } from "./types";

export const benchCommand: Command = {
  name: "bench",
  usage: "bench [--decision d] [--adapters rules,ollama,jev] [--since 30d] [--limit n] [--json]",
  async run(args, ctx) {
    const bad = (message: string) => ({ code: 2, out: "", err: `pacer: ${message}\n` });
    let decision: DecisionName | undefined;
    let selected: AdapterId[] | undefined;
    let sinceS = 0;
    let limit = 500;
    let json = false;
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (flag === "--json") { json = true; continue; }
      if (!["--decision", "--adapters", "--since", "--limit"].includes(flag)) return bad(`unknown flag: ${flag}`);
      const value = args[++i];
      if (!value || value.startsWith("--")) return bad(`${flag} requires a value`);
      if (flag === "--decision") {
        if (!(DECISIONS as readonly string[]).includes(value)) return bad(`unknown decision: ${value}`);
        decision = value as DecisionName;
      } else if (flag === "--adapters") {
        const ids = value.split(",");
        if (ids.some(id => !(ADAPTER_IDS as readonly string[]).includes(id))) return bad(`unknown adapter: ${value}`);
        selected = [...new Set(ids)] as AdapterId[];
      } else if (flag === "--since") {
        const duration = parseDuration(value);
        if (duration === null || !Number.isFinite(duration) || duration <= 0) return bad(`invalid duration: ${value}`);
        sinceS = duration;
      } else {
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) return bad(`invalid limit: ${value}`);
        limit = Number(value);
      }
    }
    try {
      let cfg;
      try { cfg = classifierConfig(loadStrategy(ctx)); }
      catch (error) {
        if (!(error instanceof MissingStrategyError)) throw error;
        cfg = validateClassifier({}, {});
      }
      const ids = selected ?? [...new Set<AdapterId>(["rules", cfg.default, ...Object.values(cfg.decisions).map(d => d.use), ...cfg.shadow])];
      const report = await runBench(ctx, cfg, buildAdapters(ctx, cfg, cfg.bench.timeoutMs), { decision, adapters: ids, sinceS, limit });
      return { code: 0, out: json ? JSON.stringify(report, null, 2) + "\n" : renderBench(report), err: "" };
    } catch (error) {
      if (error instanceof StrategyError || error instanceof ClassifierConfigError) return bad(error.message);
      throw error;
    }
  },
};

export const COMMANDS: Command[] = [benchCommand];
