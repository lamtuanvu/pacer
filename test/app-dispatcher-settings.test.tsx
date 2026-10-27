import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { dispatchConfigSchema } from "../src/dispatch/types";
import { SETTINGS_PAGES } from "../app/src/settings-pages";
import { DispatcherOverview, DispatcherModelInventory, DispatcherPreviewResult, DispatcherLadderFields, DispatcherEditor, DispatcherReadError, DispatcherSection, DispatcherEnforcementRows, scopedEnforcementReading, candidateRestriction } from "../app/src/screens/settings/Dispatcher";
import { TaskContext } from "../app/src/screens/task-shared";
import { initialState } from "../app/src/data/store";

test("dispatcher settings explain the active planner and built-in ladder", () => {
  const html = renderToString(<DispatcherOverview view={{strategy:"default",planner:"claude-code",plannerAccount:"claude1",source:"built-in",config:dispatchConfigSchema.parse({})}} />);
  expect(SETTINGS_PAGES.some(page=>page.id==="dispatcher")).toBe(true);
  expect(SETTINGS_PAGES.some(page=>page.id==="routing"||page.id==="strategies")).toBe(false);
  expect(html).toContain("Claude Code");
  expect(html).toContain("claude1");
  expect(html).toContain("Any executor");
  expect(html).toContain("built-in");
  expect(html).toContain("Capable model with spare capacity");
  expect(html).toContain("Usable fallback");
  expect(html).toContain("Project override");
  expect(html).toContain("Global eligibility rules");
  expect(html).toContain("Rank by Task fit, Spare capacity");
  expect(html).not.toContain("task-fit");
});
test("plugin strategy does not present inactive ladder as the active decision engine", () => {
  const config=dispatchConfigSchema.parse({engine:"plugin:custom-choice",engineFallback:"queue"});
  const html=renderToString(<DispatcherOverview view={{strategy:"custom",planner:"codex",plannerAccount:"work",source:"strategy",config}}/>);
  expect(html).toContain("plugin custom-choice");
  expect(html).toContain("If the plugin cannot decide, Pacer queues the work");
  expect(html).not.toContain("Capable model with spare capacity");
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
test("ladder editor saves a new strategy before activation", () => {
  const html=renderToString(<DispatcherEditor view={{strategy:"default",planner:"claude-code",plannerAccount:"claude1",source:"built-in",config:dispatchConfigSchema.parse({})}} onActivated={()=>{}} call={async<T,>()=>undefined as T}/>);
  expect(html).toContain("Save and use a new profile");
  expect(html).toContain("Profile name");
  expect(html).toContain("Reason for change");
  expect(html).toContain("Validate and activate");
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
    {runner:"claude-code",account:"team",agent:"claude-code",version:"2.1.281",probeSupported:true,unsupportedReason:null,probeMode:"ask" as const,state:"certified" as const,lastProbedAt:null,expiresAt:null,nextEligibleAt:0,probesToday:0,lastCostPct:null,consent:"unasked" as const},
    {runner:"claude-code-spare",account:"spare",agent:"claude-code",version:"2.1.281",probeSupported:true,unsupportedReason:null,probeMode:"ask" as const,state:"uncertified" as const,lastProbedAt:null,expiresAt:null,nextEligibleAt:0,probesToday:0,lastCostPct:null,consent:"unasked" as const},
    {runner:"codex",account:"personal",agent:"codex",version:"0.164.0",probeSupported:false,probeMode:"ask" as const,state:"uncertified" as const,reason:"Native subagent control: Codex tool-result observation is not implemented for this CLI version",unsupportedReason:"Native subagent control: Codex tool-result observation is not implemented for this CLI version",lastProbedAt:null,expiresAt:null,nextEligibleAt:0,probesToday:0,lastCostPct:null,consent:"unasked" as const},
    {runner:"cursor",account:"work",agent:"cursor",version:"1.0.0",probeSupported:false,probeMode:"ask" as const,state:"uncertified" as const,reason:"No blocking control",unsupportedReason:"Cursor has not proven that subagentStart denial prevents child startup",lastProbedAt:null,expiresAt:null,nextEligibleAt:0,probesToday:0,lastCostPct:null,consent:"unasked" as const},
    {runner:"interactive",account:"work",agent:"claude-code",version:"2.1.281",probeSupported:false,probeMode:"ask" as const,state:"uncertified" as const,reason:"Native child blocking for interactive launches has not been verified",unsupportedReason:"Native child blocking for interactive launches has not been verified",lastProbedAt:null,expiresAt:null,nextEligibleAt:0,probesToday:0,lastCostPct:null,consent:"unasked" as const},
  ]};
  const html=renderToString(<DispatcherEnforcementRows reading={reading} canProbe probing={null} onProbe={()=>{}} onConsent={()=>{}}/>);
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
test("shows the next scheduled probe and the measured cost",()=>{
  const now=Date.now()/1000;
  const reading={repo:"/repo",scope:"native",runners:[{
    runner:"claude-code",account:"claude1",agent:"claude-code",version:"2.1.281",
    probeSupported:true,probeMode:"ask" as const,state:"uncertified" as const,
    lastProbedAt:now-86400,expiresAt:null,
    nextEligibleAt:now+1800,probesToday:1,lastCostPct:2,
    consent:"granted" as const,unsupportedReason:null,
  }]};
  const html=renderToString(<DispatcherEnforcementRows reading={reading} canProbe={false} probing={null} onProbe={()=>{}} onConsent={()=>{}}/>);
  expect(html).toContain("next eligible");
  expect(html).toContain("probes today: 1");
  expect(html).toContain("2.0%");
  expect(html).toContain("last probe");
  expect(html).not.toContain("error");
  expect(html).not.toContain("failed");
});
test("says scheduled probing is off without implying a failure or offering a dead control",()=>{
  const reading={repo:"/repo",scope:"native subagent entry points at admission",runners:[{
    runner:"claude-code",account:"claude1",agent:"claude-code",version:"2.1.281",
    probeSupported:true,unsupportedReason:null,probeMode:"off" as const,state:"uncertified" as const,
    lastProbedAt:null,expiresAt:null,nextEligibleAt:0,probesToday:0,lastCostPct:null,
    consent:"unasked" as const,
  }]};
  const html=renderToString(<DispatcherEnforcementRows reading={reading} canProbe={false} probing={null} onProbe={()=>{}} onConsent={()=>{}}/>);
  expect(html).toContain("scheduled probing: off");
  expect(html).not.toContain("Grant consent");
  expect(html).not.toContain("alert");
  expect(html).not.toContain("failed");
});

test("offers consent when the account has not been asked",()=>{
  let consentCall:{account:string;granted:boolean}|null=null;
  const reading={repo:"/repo",scope:"native",runners:[{
    runner:"claude-code",account:"claude1",agent:"claude-code",version:"2.1.281",
    probeSupported:true,probeMode:"ask" as const,state:"uncertified" as const,
    lastProbedAt:null,expiresAt:null,nextEligibleAt:0,probesToday:0,lastCostPct:null,
    consent:"unasked" as const,unsupportedReason:null,
  }]};
  const html=renderToString(<DispatcherEnforcementRows reading={reading} canProbe={false} probing={null} onProbe={()=>{}} onConsent={(account,granted)=>{consentCall={account,granted};}}/>);
  expect(html).toContain("Grant consent");
  expect(html).toContain("Decline");
  expect(html).toContain("quota");
  expect(html).toContain("certification");
  expect(html).not.toContain("consent: granted");
  expect(html).not.toContain("consent: declined");
});
test("shows the unsupported reason instead of a schedule when probing cannot run",()=>{
  const reading={repo:"/repo",scope:"native",runners:[{
    runner:"codex",account:"work",agent:"codex",version:"0.164.0",
    probeSupported:false,probeMode:"ask" as const,state:"uncertified" as const,
    reason:"Native subagent control: Codex tool-result observation is not implemented for this CLI version",
    lastProbedAt:null,expiresAt:null,nextEligibleAt:0,probesToday:0,lastCostPct:null,
    consent:"unasked" as const,
    unsupportedReason:"Native subagent control: Codex tool-result observation is not implemented for this CLI version",
  }]};
  const html=renderToString(<DispatcherEnforcementRows reading={reading} canProbe={false} probing={null} onProbe={()=>{}} onConsent={()=>{}}/>);
  expect(html).toContain("Verification is not available");
  // The reason belongs on one line only; it used to render twice.
  expect(html.split("Verification is not available").length-1).toBe(1);
  expect(html).not.toContain("next eligible");
  expect(html).not.toContain("probes today");
  expect(html).not.toContain("consent");
});
test("schedule section distinguishes consent states and presents probing status honestly",()=>{
  // Consent granted
  const granted={repo:"/repo",scope:"native",runners:[{
    runner:"claude-code",account:"claude1",agent:"claude-code",version:"2.1.281",
    probeSupported:true,probeMode:"ask" as const,state:"certified" as const,
    lastProbedAt:Date.now()/1000-3600,expiresAt:Date.now()/1000+82800,
    nextEligibleAt:0,probesToday:1,lastCostPct:2,
    consent:"granted" as const,unsupportedReason:null,
  }]};
  const htmlGranted=renderToString(<DispatcherEnforcementRows reading={granted} canProbe={false} probing={null} onProbe={()=>{}} onConsent={()=>{}}/>);
  expect(htmlGranted).toContain("consent: granted");
  expect(htmlGranted).not.toContain("Grant consent");  // No buttons when consent is set
  expect(htmlGranted).not.toContain("Decline");
  
  // Consent declined - NOT an error state
  const declined={repo:"/repo",scope:"native",runners:[{
    runner:"claude-code",account:"claude1",agent:"claude-code",version:"2.1.281",
    probeSupported:true,probeMode:"ask" as const,state:"uncertified" as const,
    lastProbedAt:null,expiresAt:null,nextEligibleAt:0,probesToday:0,lastCostPct:null,
    consent:"declined" as const,unsupportedReason:null,
  }]};
  const htmlDeclined=renderToString(<DispatcherEnforcementRows reading={declined} canProbe={false} probing={null} onProbe={()=>{}} onConsent={()=>{}}/>);
  expect(htmlDeclined).toContain("consent: declined");
  expect(htmlDeclined).not.toContain("Grant consent");  // No buttons when consent is set
  // Must not show error/warning language for declined consent
  expect(htmlDeclined).not.toMatch(/error|fail|warn|problem|broke/i);
});
