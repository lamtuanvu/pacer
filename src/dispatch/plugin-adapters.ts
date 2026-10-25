import type {Ctx} from "../types";
import {pluginRegistry} from "../plugins";
import type {ObservationAdapter} from "./observations";
import type {DecisionEngine} from "./engines";
import type {DecisionRequest,Observation,ObservationMethod,ObservationScope} from "./types";

/** Plugins receive normalized data only; they never see service credentials or an execution handle. */
export function pluginObservationAdapter(id:string):ObservationAdapter {
 return {id:`plugin:${id}`,methods:["models","capabilities","usage","health","actual-model"],
  async observe(ctx:Ctx,scope:ObservationScope,method:ObservationMethod):Promise<Observation[]>{
   const rows=await pluginRegistry(ctx).call<Observation[]>(ctx,id,"observation.observe",{scope,method});
   return rows.map(row=>({...row,source:`plugin:${id}`}));
  }};
}
export function pluginDecisionEngine(ctx:Ctx,id:string):DecisionEngine {
 return {id:`plugin:${id}`,version:"1",async decide(request:DecisionRequest){return pluginRegistry(ctx).call(ctx,id,"decision.decide",request);}};
}
