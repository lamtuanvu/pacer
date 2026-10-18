import { classifierConfig, validateClassifier, type ClassifierConfig } from "../config/classifier";
import { KINDS, loadStrategy, type Strategy } from "../config/strategy";
import type { Ctx } from "../types";
import { decide } from "./decide";
import type { DecisionHooks } from "./hooks";
import { buildAdapters, type AdapterSet } from "./registry";
import { QUESTIONS, difficultyState, guardState, resultCheckState, taskKindState } from "./state";

interface HookDeps {
  loadStrategy: (ctx: Ctx) => Strategy;
  adapters: (ctx: Ctx, cfg: ClassifierConfig) => AdapterSet;
  repoFiles: (ctx: Ctx, repo: string) => Promise<number | null>;
}

export async function countRepoFiles(ctx: Ctx, repo: string): Promise<number | null> {
  try {
    const result = await ctx.run(["git", "-C", repo, "ls-files"], 3000);
    return result.code === 0 ? result.stdout.split("\n").filter(Boolean).length : null;
  } catch { return null; }
}

/** Map insertion order tracks recency, including reads of in-flight decisions. */
class TaskCache<T> extends Map<string, T> {
  override get(key: string): T | undefined {
    const value = super.get(key);
    if (value !== undefined) {
      super.delete(key);
      super.set(key, value);
    }
    return value;
  }

  override set(key: string, value: T): this {
    super.delete(key);
    super.set(key, value);
    if (this.size > 500) super.delete(this.keys().next().value!);
    return this;
  }
}

export function makeClassifierHooks(deps: Partial<HookDeps> = {}): DecisionHooks {
  const load = deps.loadStrategy ?? loadStrategy;
  const adapters = deps.adapters ?? ((ctx, cfg) => buildAdapters(ctx, cfg, cfg.timeoutMs));
  const repoFiles = deps.repoFiles ?? countRepoFiles;
  const kindCache = new TaskCache<Promise<string | null>>();
  const difficultyCache = new TaskCache<Promise<number | null>>();
  const config = (ctx: Ctx, strategy?: Strategy): ClassifierConfig => {
    let s = strategy;
    try {
      s ??= load(ctx);
      return classifierConfig(s);
    } catch { return validateClassifier({}, s?.providers ?? {}); }
  };
  // Keyed by home as well as id: ids are only unique within one pacer home.
  const key = (ctx: Ctx, id: string) => `${ctx.pacerHome}\0${id}`;
  const hooks: DecisionHooks = {
    taskKind(ctx, task) {
      let pending = kindCache.get(key(ctx, task.id));
      if (!pending) {
        pending = (async () => {
          const cfg = config(ctx);
          const tagged = task.kind !== null && !cfg.decisions.task_kind.verifyKind;
          const decision = await decide(ctx, cfg, adapters(ctx, cfg), {
            decision: "task_kind", state: taskKindState(task), question: QUESTIONS.task_kind,
            taskId: task.id, actedOn: tagged || cfg.configured, ...(tagged ? { use: "rules" as const } : {}),
          });
          if (tagged || !cfg.configured) return task.kind;
          const value = decision.answer.value;
          return typeof value === "string" && (KINDS as readonly string[]).includes(value) ? value : task.kind;
        })().catch(() => task.kind);
        kindCache.set(key(ctx, task.id), pending);
      }
      return pending;
    },
    async filterExecutors(ctx, task, ranked, s) {
      try {
        const cfg = config(ctx, s);
        const threshold = cfg.decisions.difficulty.maxForCheap;
        let pending = difficultyCache.get(key(ctx, task.id));
        if (!pending) {
          pending = (async () => {
            const kind = kindCache.has(key(ctx, task.id)) ? await kindCache.get(key(ctx, task.id))! : task.kind;
            const set = adapters(ctx, cfg);
            const hasShadow = cfg.shadow.some(id => id !== cfg.decisions.difficulty.use
              && (!set[id].external || cfg.shadowExternal));
            const files = threshold > 0 || hasShadow
              ? await repoFiles(ctx, task.brief.repo).catch(() => null) : null;
            const decision = await decide(ctx, cfg, set, {
              decision: "difficulty", state: difficultyState(task, kind, files), question: QUESTIONS.difficulty,
              taskId: task.id, actedOn: threshold > 0,
            });
            return typeof decision.answer.value === "number" ? decision.answer.value : null;
          })().catch(() => null);
          difficultyCache.set(key(ctx, task.id), pending);
        }
        const score = await pending;
        if (threshold > 0 && score !== null && score < threshold) {
          const capable = ranked.filter(id => cfg.tiers[id] === "capable");
          if (capable.length) return capable;
        }
      } catch { /* Preserve routing when a dependency fails. */ }
      return ranked;
    },
    async resultCheck(ctx, task, result) {
      try {
        const cfg = config(ctx);
        const decision = await decide(ctx, cfg, adapters(ctx, cfg), {
          decision: "result_check", state: resultCheckState(task, result), question: QUESTIONS.result_check,
          taskId: task.id, actedOn: true,
        });
        return { pass: decision.answer.value === true, confidence: decision.answer.confidence, adapter: decision.adapter };
      } catch { return undefined; }
    },
    async guard(ctx, input) {
      if (ctx.env.PACER === "off") return null;
      try {
        const cfg = config(ctx);
        const decision = await decide(ctx, cfg, adapters(ctx, cfg), {
          decision: "guard", state: guardState(input), question: QUESTIONS.guard, actedOn: true,
        });
        if (decision.adapter !== "rules" && !decision.fallback && decision.answer.value === false) {
          return { allow: true, reason: "Classifier identified non-execution work", adapter: decision.adapter, confidence: decision.answer.confidence };
        }
      } catch { /* No opinion: the guard applies its own rules. */ }
      return null;
    },
  };
  return hooks;
}
