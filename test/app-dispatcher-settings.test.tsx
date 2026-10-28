import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { dispatchConfigSchema } from "../src/dispatch/types";
import { SETTINGS_PAGES } from "../app/src/settings-pages";
import { DispatcherOverview, DispatcherModelInventory, DispatcherPreviewResult, DispatcherLadderFields, DispatcherReadError, DispatcherSection, DispatcherEnforcementRows, scopedEnforcementReading, candidateRestriction, RouteExplanationResult, SavedSetups } from "../app/src/screens/settings/Dispatcher";
import { SetupEditor } from "../app/src/screens/settings/DispatcherSetup";
import { TaskContext } from "../app/src/screens/task-shared";
import { initialState } from "../app/src/data/store";

test("dispatcher settings explain the active planner and built-in ladder", () => {
  const html = renderToString(<DispatcherOverview view={{strategy:"default",planner:"claude-code",plannerAccount:"claude1",source:"built-in",config:dispatchConfigSchema.parse({})}} />);
  expect(SETTINGS_PAGES.some(page=>page.id==="dispatcher")).toBe(true);
  expect(SETTINGS_PAGES.some(page=>page.id==="routing"||page.id==="strategies")).toBe(false);
  expect(html).toContain("Claude Code");
  expect(html).toContain('aria-label="Current setup"');
  expect(html).toContain('href="#/settings/planner"');
  expect(html).toContain("Switch setup");
  expect(html).toContain("Active saved setup");
  expect(html).not.toContain("Repository choices");
  // The ladder itself is shown once, in the guided setup's step 3 (UI-15).
  expect(html).not.toContain("Usable fallback");
  const ladder=renderToString(<DispatcherLadderFields config={dispatchConfigSchema.parse({})} onChange={()=>{}}/>);
  expect(ladder).toContain("Capable model with spare capacity");
  expect(ladder).toContain("Usable fallback");
  expect(ladder).toContain("Rank by Task fit, Spare capacity");
  expect(ladder).not.toContain("task-fit");
});
test("plugin strategy does not present inactive ladder as the active decision engine", () => {
  const config=dispatchConfigSchema.parse({engine:"plugin:custom-choice",engineFallback:"queue"});
  const html=renderToString(<DispatcherOverview view={{strategy:"custom",planner:"codex",plannerAccount:"work",source:"strategy",config}}/>);
  expect(html).toContain("custom");
  expect(html).not.toContain("Capable model with spare capacity");
  const setup=renderToString(<TaskContext.Provider value={{state:{...initialState(),connected:true},api:{call:async()=>({})}} as any}><SetupEditor view={{strategy:"custom",planner:"codex",plannerAccount:"work",source:"strategy",config}} eligibility={{kind:"global",rules:[{executors:["codex"]}],available:["codex"]}} onSaved={()=>{}} onDirtyChange={()=>{}}/></TaskContext.Provider>);
  expect(setup).toContain("If the plugin cannot decide, Pacer queues the work");
  expect(setup).not.toContain("Capable model with spare capacity");
});
test("older services explain the missing dispatcher capability without calling it", () => {
  let calls=0;
  const html=renderToString(<TaskContext.Provider value={{state:initialState(),api:{call:async()=>{calls++;return {};}}} as any}><DispatcherSection query={{repo:null,scope:null}}/></TaskContext.Provider>);
  expect(html).toContain("does not support dispatcher settings yet");
  expect(calls).toBe(0);
});
test("ladder setup exposes ordered steps, restrictions, capacity and fallback", () => {
  const html=renderToString(<DispatcherLadderFields config={dispatchConfigSchema.parse({})} onChange={()=>{}}/>);
  expect(html).toContain("Step 1");
  expect(html).toContain("Capable model with spare capacity");
  expect(html).toContain("Only these models");
  expect(html).toContain("Prefer these models");
  expect(html).toContain("Minimum model tier");
  expect(html).toContain("Spare capacity threshold");
  expect(html).toContain("When no step matches");
});
test("clearing an optional candidate restriction restores unrestricted matching", () => {
  const narrowed=candidateRestriction({},"models","provider/deep");
  expect(narrowed.models).toEqual(["provider/deep"]);
  const restored=candidateRestriction(narrowed,"models","");
  expect(restored.models).toBeUndefined();
  expect(JSON.stringify(restored)).toBe("{}");
});
test("retained settings and models expose refresh failure and retry", () => {
  const html=renderToString(<DispatcherReadError error={new Error("Read unavailable")} subject="model choices" reload={()=>{}}/>);
  expect(html).toContain("Showing the last loaded reading");
  expect(html).toContain("Read unavailable");
  expect(html).toContain("Try again");
});
test("model inventory and preview distinguish a declared model from unknown identity", () => {
  const models=renderToString(<DispatcherModelInventory inventory={{models:[{runner:"codex",account:"codex",executor:"codex",binding:{kind:"executor-default"},actualModel:null,tier:"unknown",strengths:[],provenance:"declared"}],advertised:[],observedAt:null}}/>);
  expect(models).toContain("Codex");
  expect(models).toContain("Agent default");
  expect(models).toContain("Exact model unknown");
  const preview=renderToString(<DispatcherPreviewResult preview={{engine:{id:"ladder",version:"1"},validation:"valid",proposal:{state:"ranked",step:"capable-with-headroom",choices:[{id:"candidate",factors:[],reason:"internal"}],skipped:[]},request:{candidates:[{id:"candidate",runner:"codex",executor:"codex",binding:{kind:"executor-default"},headroom:78}]},recommendedAction:"select",excluded:[],uncertainty:["codex: executor default model unresolved"]} as any}/>);
  expect(preview).toContain("Capable model with spare capacity");
  expect(preview).toContain("Codex");
  expect(preview).toContain("78% spare capacity");
  expect(preview).toContain("Exact model unknown");
  expect(preview).not.toContain("internal");
  const timedOut=renderToString(<DispatcherPreviewResult preview={{validation:"timeout",proposal:null,recommendedAction:"queue",excluded:[],uncertainty:[]} as any}/>);
  expect(timedOut).toContain("decision engine timed out");
  expect(timedOut).not.toContain("No eligible choice now");
  const excluded=renderToString(<DispatcherPreviewResult preview={{validation:"valid",proposal:{state:"none"},recommendedAction:"queue",excluded:[{id:"codex",reason:"Native subagent control: Codex tool-result observation is not implemented for this CLI version"},{id:"cursor",reason:"/private/secret/config.json could not be read"}],uncertainty:[]} as any}/>);
  expect(excluded).toContain("Verification is not available for this executor yet");
  expect(excluded).toContain("This executor is not eligible for this task");
  expect(excluded).not.toContain("tool-result");
  expect(excluded).not.toContain("/private/secret");
});
test("native control rows distinguish verified, actionable and unavailable executors",()=>{
  const reading={repo:"/repo",scope:"native",runners:[
    {runner:"claude-code",account:"team",agent:"claude-code",version:"2.1.281",probeSupported:true,state:"certified" as const},
    {runner:"claude-code-spare",account:"spare",agent:"claude-code",version:"2.1.281",probeSupported:true,state:"uncertified" as const},
    {runner:"codex",account:"personal",agent:"codex",version:"0.164.0",probeSupported:false,state:"uncertified" as const,reason:"Native subagent control: Codex tool-result observation is not implemented for this CLI version"},
    {runner:"cursor",account:"work",agent:"cursor",version:"1.0.0",probeSupported:false,state:"uncertified" as const,reason:"No blocking control"},
    {runner:"interactive",account:"work",agent:"claude-code",version:"2.1.281",probeSupported:false,state:"uncertified" as const,reason:"Native child blocking for interactive launches has not been verified"},
  ]};
  const html=renderToString(<DispatcherEnforcementRows reading={reading} canProbe probing={null} onProbe={()=>{}}/>);
  expect(html).toContain("Verified");expect(html).toContain("Needs verification");expect(html).toContain("Unavailable");
  expect(html).toContain("View executor setup");expect(html.match(/Verify control/g)).toHaveLength(1);
  expect(html).toContain("Verification is not available for this executor yet");
  expect(html).not.toContain("Tool-result observation");
  expect(html).not.toContain("No blocking control");
  expect(html).not.toContain("Run verification before assigning managed work");
});
test("native control data follows the selected repository key without showing stale rows",()=>{
  const repos=[{key:"local:one",path:"/work/one"},{key:"local:two",path:"/work/two"}];
  const one={repo:"/work/one",scope:"native",runners:[]};
  expect(scopedEnforcementReading(one,"local:one",repos)).toBe(one);
  expect(scopedEnforcementReading(one,"local:two",repos)).toBeUndefined();
});

test("ladder rows use numbered circles and icon actions with full accessible names", () => {
  const html=renderToString(<DispatcherLadderFields config={dispatchConfigSchema.parse({})} onChange={()=>{}}/>);
  expect(html).toContain('pc-sortable--icons');
  expect(html).toContain('aria-hidden="true" class="pc-ladder-number">1</span>');
  expect(html).toContain('aria-label="Move down: Capable model with spare capacity"');
  expect(html).not.toContain('>Move down</button>');
});

test("route results group choice and matched step in a band and distinguish exclusion severity", () => {
  const result={chosen:{runner:"codex",executor:"codex",account:"work",model:{kind:"executor-default"},host:null},outcome:"select",step:{index:0,id:"capable-with-headroom"},strategy:{draft:false},reasons:[],fallbacks:[
    ...["executor_busy","quota_exhausted","planner_account","brand_new"].map((code,index)=>({runner:`executor${index}`,state:"excluded",reason:{code,outcome:"fail",facts:{},text:"internal raw detail"}})),
    {runner:"cursor",state:"eligible"},
  ],planner:{state:"unknown",reason:"planner_not_measured"},uncertainty:[]};
  const html=renderToString(<RouteExplanationResult result={result as any}/>);
  expect(html).toContain('pc-route-result__header');
  expect(html).toContain('pc-route-result__name');
  expect(html).toContain('Matched: Step 1 · Capable model with spare capacity');
  for(const [tone,glyph] of [["soft","◐"],["hard","✕"],["neutral","–"],["good","✓"]])expect(html).toContain(`pc-route-result__glyph--${tone}">${glyph}</span>`);
  expect(html).not.toContain('internal raw detail');
  expect(html).not.toContain('brand_new');
  const queued=renderToString(<RouteExplanationResult result={{...result,chosen:null,step:null,outcome:"queue"} as any}/>);
  expect(queued).toContain('Pacer would hold this task');
  expect(queued).not.toContain('Would go to');
});

test("saved setup rows retain explicit Use actions and mark the active row", () => {
  const rows=[{name:"daily",summary:"Everyday work",active:true},{name:"other",summary:"Other work",active:false}];
  const html=renderToString(<TaskContext.Provider value={{state:initialState(),api:{call:async()=>rows}} as any}><SavedSetups initialData={rows as any}/></TaskContext.Provider>);
  expect(html).toContain('pc-saved-setups__row--active');
  expect(html).toContain('aria-label="Use other"');
  expect(html).toContain('pc-setup-icon');
});
