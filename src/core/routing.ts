import { projectSnapshot } from "./project-policy";
import { projectPolicy } from "../engine/project-routing";
import { classifierConfig } from "../config/classifier";
import { decide } from "../classify/decide";
import { buildAdapters } from "../classify/registry";
import { QUESTIONS } from "../classify/state";
import { KINDS } from "../config/strategy";
import { resolveRepoInput } from "./repos";
import { type Strategy, loadStrategy } from "../config/strategy";
import { rankExecutors } from "../engine/rank";
import { type Status, computeStatus } from "../engine/status";
import { remoteExclusion } from "../remote/eligibility";
import type { Ctx } from "../types";

export function status(ctx: Ctx, s: Strategy = loadStrategy(ctx)): Promise<Status> {
  return computeStatus(ctx, s);
}

export async function route(ctx: Ctx, kind: string | null, s: Strategy = loadStrategy(ctx), o: {goal?:string;repo?:string} = {}) {
  const repo=o.repo===undefined?undefined:await resolveRepoInput(ctx,o.repo);
  if(kind===null && o.goal!==undefined) {
    const cfg=classifierConfig(s);
    const result=await decide(ctx,cfg,buildAdapters(ctx,cfg,cfg.timeoutMs),{
      decision:"task_kind",state:JSON.stringify({goal:o.goal,planner_kind:null}),question:QUESTIONS.task_kind,actedOn:false,
    });
    const value=result.answer.value;
    if(typeof value==="string" && (KINDS as readonly string[]).includes(value))kind=value;
  }
  const selection = repo ? projectSnapshot(ctx, s, repo.key).selection : undefined;
  const st = await computeStatus(ctx, s);
  await Promise.all(st.providers.map(async p => {
    const reason = await remoteExclusion(ctx, s, p.id, repo ? {repo:repo.path,placement:"new"} : undefined);
    if (reason) p.unavailableReason = reason;
  }));
  const r = rankExecutors(kind, s, Object.fromEntries(st.providers.map((p) => [p.id, p])), selection && { executors: selection.executors, order: "configured" });
  return { ...(selection ? { policy: projectPolicy(selection) } : {}), kind, ranked: r.ranked, excluded: r.excluded };
}
