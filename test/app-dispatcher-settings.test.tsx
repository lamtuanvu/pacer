import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { dispatchConfigSchema } from "../src/dispatch/types";
import { SETTINGS_PAGES } from "../app/src/settings-pages";
import { DispatcherOverview, DispatcherModelInventory, DispatcherPreviewResult, DispatcherLadderFields, DispatcherEditor, DispatcherReadError, DispatcherSection, candidateRestriction } from "../app/src/screens/settings/Dispatcher";
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
});
