import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToString } from "preact-render-to-string";
import { dispatchConfigSchema } from "../src/dispatch/types";
import { MAX_PROBES_PER_DAY, MAX_COST_PCT } from "../src/view-model/certification-schedule";
import { SETTINGS_PAGES } from "../app/src/settings-pages";
import { DispatcherOverview, DispatcherModelInventory, DispatcherPreviewResult, DispatcherLadderFields, DispatcherEditor, DispatcherReadError, DispatcherSection, DispatcherEnforcementRows, scopedEnforcementReading, candidateRestriction, consentActions } from "../app/src/screens/settings/Dispatcher";
import { TaskContext } from "../app/src/screens/task-shared";
import { initialState } from "../app/src/data/store";

// Pin the consent wiring: the control passes `send` through unchanged, so an
// inverted boolean or a wrong account in the payload must fail here.
test("each consent button sends the account and value its label promises", () => {
  const sends = (account: string, consent: "granted" | "declined" | "unasked") =>
    consentActions(account, consent).map(a => [a.label, a.send]);
  expect(sends("claude1", "unasked")).toEqual([["Grant consent", ["claude1", true]], ["Decline", ["claude1", false]]]);
  expect(sends("claude1", "granted")).toEqual([["Withdraw consent", ["claude1", false]]]);
  expect(sends("claude1", "declined")).toEqual([["Grant consent", ["claude1", true]]]);
  expect(sends("team", "declined")).toEqual([["Grant consent", ["team", true]]]);
  expect(consentActions("team", "unasked")[0].ariaLabel).toBe("Grant consent for team");
});
test("withdrawing consent is as visible as granting it", () => {
  expect(consentActions("claude1", "granted")[0].variant).toBe(consentActions("claude1", "unasked")[0].variant);
});

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
  // FIX 3 (QA F8): Positive assertions that can actually fail
  expect(html).toContain("next eligible");
  expect(html).toContain("probes today: 1");
  expect(html).toContain("2.0%");
  expect(html).toContain("last probe");
  expect(html).toContain("consent: granted");
  // Changeable consent (FIX 1): granted account offers "Withdraw consent"
  expect(html).toContain("Withdraw consent");
  expect(html).toContain(`aria-label="Withdraw consent for claude1"`);
});
test("says scheduled probing is off without implying a failure or offering a dead control",()=>{
  const reading={repo:"/repo",scope:"native subagent entry points at admission",runners:[{
    runner:"claude-code",account:"claude1",agent:"claude-code",version:"2.1.281",
    probeSupported:true,unsupportedReason:null,probeMode:"off" as const,state:"uncertified" as const,
    lastProbedAt:null,expiresAt:null,nextEligibleAt:0,probesToday:0,lastCostPct:null,
    consent:"unasked" as const,
  }]};
  const html=renderToString(<DispatcherEnforcementRows reading={reading} canProbe={false} probing={null} onProbe={()=>{}} onConsent={()=>{}}/>);
  // FIX 3 (QA F8): Positive assertions that can actually fail
  expect(html).toContain("scheduled probing: off");
  expect(html).toContain("Needs verification");
  // No consent controls when probeMode is off
  expect(html).not.toContain("Grant consent");
  expect(html).not.toContain("Decline");
  expect(html).not.toContain("Withdraw consent");
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
  // FIX 1: accessible name includes account
  expect(html).toContain(`aria-label="Grant consent for claude1"`);
  expect(html).toContain(`aria-label="Decline probes for claude1"`);
  // FIX 2: copy does not use bare "planner reserve" phrase
  expect(html).not.toContain("the planner reserve");
  // FIX 3: bounds appear when lastCostPct is null
  expect(html).toContain(`${MAX_PROBES_PER_DAY} probes per day`);
  expect(html).toContain(`pauses probing for at least 24 hours if one costs more than ${MAX_COST_PCT}% of the account's window, then retries when eligible.`);
  expect(html).toContain("expire within 24 hours");
});

test("consent buttons have distinct accessible names per account",()=>{
  const reading={repo:"/repo",scope:"native",runners:[
    {
      runner:"claude-code",account:"team",agent:"claude-code",version:"2.1.281",
      probeSupported:true,probeMode:"ask" as const,state:"uncertified" as const,
      lastProbedAt:null,expiresAt:null,nextEligibleAt:0,probesToday:0,lastCostPct:null,
      consent:"unasked" as const,unsupportedReason:null,
    },
    {
      runner:"claude-code-spare",account:"spare",agent:"claude-code",version:"2.1.281",
      probeSupported:true,probeMode:"ask" as const,state:"uncertified" as const,
      lastProbedAt:null,expiresAt:null,nextEligibleAt:0,probesToday:0,lastCostPct:null,
      consent:"unasked" as const,unsupportedReason:null,
    },
  ]};
  const html=renderToString(<DispatcherEnforcementRows reading={reading} canProbe={false} probing={null} onProbe={()=>{}} onConsent={()=>{}}/>);
  // Each account's accessible name is distinct
  expect(html).toContain(`aria-label="Grant consent for team"`);
  expect(html).toContain(`aria-label="Decline probes for team"`);
  expect(html).toContain(`aria-label="Grant consent for spare"`);
  expect(html).toContain(`aria-label="Decline probes for spare"`);
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
  // FIX 1 (UI-13): Granted account offers a way to stop (Withdraw consent)
  expect(htmlGranted).toContain("Withdraw consent");
  expect(htmlGranted).toContain(`aria-label="Withdraw consent for claude1"`);
  // No Decline or Grant buttons when already granted
  expect(htmlGranted).not.toContain(`aria-label="Grant consent for claude1"`);
  expect(htmlGranted).not.toContain(`aria-label="Decline probes for claude1"`);

  // Consent declined - NOT an error state
  const declined={repo:"/repo",scope:"native",runners:[{
    runner:"claude-code",account:"claude1",agent:"claude-code",version:"2.1.281",
    probeSupported:true,probeMode:"ask" as const,state:"uncertified" as const,
    lastProbedAt:null,expiresAt:null,nextEligibleAt:0,probesToday:0,lastCostPct:null,
    consent:"declined" as const,unsupportedReason:null,
  }]};
  const htmlDeclined=renderToString(<DispatcherEnforcementRows reading={declined} canProbe={false} probing={null} onProbe={()=>{}} onConsent={()=>{}}/>);
  expect(htmlDeclined).toContain("consent: declined");
  // FIX 1 (UI-13): Declined account offers a way to allow (Grant consent)
  expect(htmlDeclined).toContain(`aria-label="Grant consent for claude1"`);
  expect(htmlDeclined).not.toContain("Withdraw consent");
  expect(htmlDeclined).not.toContain(`aria-label="Decline probes for claude1"`);
  // Declined is plain state: the schedule line reads exactly that and nothing more.
  expect(htmlDeclined).toContain(`<div class="u3-muted">consent: declined</div>`);
});
const consentRunner=(consent:"granted"|"declined"|"unasked")=>({repo:"/repo",scope:"native",runners:[{
  runner:"claude-code",account:"claude1",agent:"claude-code",version:"2.1.281",
  probeSupported:true,probeMode:"ask" as const,state:"uncertified" as const,
  lastProbedAt:null,expiresAt:null,nextEligibleAt:0,probesToday:0,lastCostPct:null,
  consent,unsupportedReason:null,
}]});
test("a declined account offered a grant sees what the grant costs",()=>{
  // Consent can be declined from the CLI, so this may be the first time the person sees the price.
  const html=renderToString(<DispatcherEnforcementRows reading={consentRunner("declined")} canProbe={false} probing={null} onProbe={()=>{}} onConsent={()=>{}}/>);
  expect(html).toContain(`aria-label="Grant consent for claude1"`);
  expect(html).toContain("<strong>claude1</strong>'s quota");
  expect(html).toContain(`${MAX_PROBES_PER_DAY} probes per day`);
  expect(html).toContain(`pauses probing for at least 24 hours if one costs more than ${MAX_COST_PCT}% of the account's window, then retries when eligible.`);
  expect(html).toContain("expire within 24 hours");
});
test("the cost disclosure goes with an offered grant, not with withdrawal",()=>{
  // The disclosure renders in the unasked and declined states, so its absence here can fail.
  const html=renderToString(<DispatcherEnforcementRows reading={consentRunner("granted")} canProbe={false} probing={null} onProbe={()=>{}} onConsent={()=>{}}/>);
  expect(html).toContain("Withdraw consent");
  expect(html).not.toContain("probes per day");
});
test("the consent block spans the whole settings row",()=>{
  // Nested in the first cell, the disclosure was squeezed into a third of the row at desktop width.
  const html=renderToString(<DispatcherEnforcementRows reading={consentRunner("unasked")} canProbe probing={null} onProbe={()=>{}} onConsent={()=>{}}/>);
  expect(html).toMatch(/^<div class="u3-setting"><div>(?:(?!<div class="u3-setting-consent).)*<\/div><button[^>]*>Verify control<\/button><div class="u3-setting-consent /s);
  const css=readFileSync(new URL("../app/src/screens/settings/settings.css",import.meta.url),"utf8");
  expect(css).toContain(".u3-setting>.u3-setting-consent{grid-column:1/-1}");
});
test("renders consent controls only when the consent operation is available",()=>{
  const props={reading:consentRunner("unasked"),canProbe:false,probing:null,onProbe:()=>{},onConsent:()=>{}};
  const without=renderToString(<DispatcherEnforcementRows {...props} canConsent={false}/>);
  const withConsent=renderToString(<DispatcherEnforcementRows {...props} canConsent/>);
  expect(withConsent).toContain(`aria-label="Grant consent for claude1"`);
  expect(withConsent).toContain("u3-setting-consent");
  expect(without).not.toContain("Grant consent");
  expect(without).not.toContain("u3-setting-consent");
  expect(without).not.toContain("probes per day");
});
test("a paused schedule says why, as plain state, and probing turned off does not",()=>{
  const now=Date.now()/1000;
  const row={
    runner:"claude-code",account:"claude1",agent:"claude-code",version:"2.1.281",
    probeSupported:true,probeMode:"auto" as const,state:"stale" as const,reason:"Native subagent control verification expired",
    lastProbedAt:now-90000,expiresAt:null,nextEligibleAt:now+80000,probesToday:1,lastCostPct:12,
    consent:"granted" as const,unsupportedReason:null,
    scheduleReason:"the last probe cost 12% of the account window",schedulePaused:true as boolean,
  };
  const render=(runner:typeof row|(Omit<typeof row,"probeMode">&{probeMode:"off"}))=>renderToString(<DispatcherEnforcementRows reading={{repo:"/repo",scope:"native",runners:[runner]}} canProbe={false} probing={null} onProbe={()=>{}} onConsent={()=>{}}/>);
  const paused=render(row);
  // The doctor's word for the same fact.
  expect(paused).toContain("probing paused: the last probe cost 12% of the account window");
  expect(paused).not.toContain("not probing now");
  // An explanation, not an alarm: it shares the muted schedule line.
  expect(paused).toMatch(/<div class="u3-muted">[^<]*probing paused: the last probe cost/);
  expect(paused).not.toContain(`role="alert"`);
  const backoff=render({...row,schedulePaused:false,scheduleReason:"waiting out the backoff from an earlier failed probe"});
  expect(backoff).toMatch(/<div class="u3-muted">[^<]*not probing now: waiting out the backoff/);
  // An older service sends no flag; that is not a pause.
  const {schedulePaused:_,...older}=row;
  expect(render(older as typeof row)).toContain("not probing now: the last probe cost");
  const off=render({...row,probeMode:"off",scheduleReason:"certification probing is turned off"});
  expect(off).toContain("scheduled probing: off");
  expect(off).not.toContain("not probing now");
});
