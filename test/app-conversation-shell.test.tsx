import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { AttachmentDelivery } from "../app/src/screens/session/Attachments";
import { Conversation, TerminalOpenFallback } from "../app/src/screens/session/Conversation";
import { SessionView } from "../app/src/screens/session/SessionView";
import { TaskContext } from "../app/src/screens/task-shared";
import { initialState } from "../app/src/data/store";
import type { TaskDetail } from "../src/core/task-detail";

test("later attachment reference requires an explicit copy step and user submission", () => {
 const html=renderToString(<AttachmentDelivery name="image.png" text='Use "image.png" at "/tmp/private/image".' onCopy={()=>{}}/>);
 expect(html).toContain("Copy reference");
 expect(html).toContain("Paste into the agent’s input, then submit when ready.");
 expect(html).not.toContain("Send message");
});
test("failed conversation shows its recorded launch error", () => {
 const previousLocation=globalThis.location;
 globalThis.location={hash:""} as Location;
 try {
 const task = {id:"task-1",state:"failed",fullTitle:"Start agent",goal:"Start agent",repo:{label:"project"},branch:null,executor:"claude-code",summary:"Integration claude-code is not ready: managed integration content changed",brief:{goal:"Start agent"}};
 const state = {snapshot:{executors:[]},invalidations:{},activity:[],connected:false};
 const html=renderToString(<TaskContext.Provider value={{api:{} as never,state:state as never}}><Conversation task={task as never} onReload={()=>{}}/></TaskContext.Provider>);
 expect(html).toContain("Integration claude-code is not ready");
 expect(html).toContain("Preserve your customizations");
 expect(html).toContain("pacer install claude-code");
 expect(html).toContain("Technical details");
 expect(html).not.toContain("The agent process ended. Your output and changes are retained.");
 } finally { globalThis.location=previousLocation; }
});

test("other failed conversations keep technical errors behind a disclosure", () => {
 const previousLocation=globalThis.location;
 globalThis.location={hash:""} as Location;
 try {
  const task={id:"task-2",state:"failed",fullTitle:"Start agent",goal:"Start agent",repo:{label:"project"},branch:null,executor:"codex",summary:"spawn failed at /tmp/private/file",brief:{goal:"Start agent"}};
  const state={snapshot:{executors:[]},invalidations:{},activity:[],connected:false};
  const html=renderToString(<TaskContext.Provider value={{api:{} as never,state:state as never}}><Conversation task={task as never} onReload={()=>{}}/></TaskContext.Provider>);
  expect(html).toContain("Open technical details for the recorded error.");
  expect(html).toContain('<details');
  expect(html).toContain("spawn failed at /tmp/private/file");
 } finally {globalThis.location=previousLocation;}
});

test("disk-full conversation explains recovery without hiding its technical error", () => {
 const previousLocation=globalThis.location;
 globalThis.location={hash:""} as Location;
 try {
  const task={id:"task-3",state:"failed",fullTitle:"Start agent",goal:"Start agent",repo:{label:"project"},branch:null,executor:"codex",summary:"pacer runner error: ENOSPC: no space left on device",brief:{goal:"Start agent"}};
  const state={snapshot:{executors:[]},invalidations:{},activity:[],connected:false};
  const html=renderToString(<TaskContext.Provider value={{api:{} as never,state:state as never}}><Conversation task={task as never} onReload={()=>{}}/></TaskContext.Provider>);
  expect(html).toContain("Free space on this machine");
  expect(html).toContain("ENOSPC");
 } finally {globalThis.location=previousLocation;}
});

test("unopened terminal shows a copyable attach command", () => {
 const html=renderToString(<TerminalOpenFallback command="pacer attach t-1"/>);
 expect(html).toContain("Terminal did not open");
 expect(html).toContain("pacer attach t-1");
});
test("conversation fills the workspace between its body and a pinned control footer, with actions in the frame",()=>{
 const api={hello:async()=>({}) as never,snapshot:async()=>({}) as never,call:async<T,>()=>({}) as T};
 const task={id:"t-1",state:"running",executor:"codex",goal:"Build a page",fullTitle:"Build a page",repo:{label:"project"},branch:"pacer/task",brief:{goal:"Build a page"}} as unknown as TaskDetail;
 Object.defineProperty(globalThis,"location",{configurable:true,value:new URL("http://localhost/app/#/tasks/t-1")});
 let html="";
 try{html=renderToString(<TaskContext.Provider value={{state:initialState(),api}}><Conversation task={task} onReload={()=>{}}/></TaskContext.Provider>);}
 finally{delete (globalThis as {location?:unknown}).location;}
 expect(html).not.toContain('role="tablist"');expect(html).not.toContain(">Terminal<");
 expect(html).toContain('class="pc-conversation-footer"');expect(html).toContain('aria-label="Session control"');
 expect(html).not.toContain("pc-conversation-actions");expect(html).not.toContain("End session");
 expect(html.indexOf("pc-conversation-body")).toBeLessThan(html.indexOf("pc-conversation-footer"));
 expect(html).toContain("Starting the session…");
});
test("session view explains queued and ended sessions without naming the renderer",()=>{
 const props={active:false,footer:null,takeRequested:false,onTakeSent:()=>{},onFiles:()=>{}};
 const queued=renderToString(<SessionView {...props} active task={{id:"t",state:"queued"} as unknown as TaskDetail}/>);
 expect(queued).toContain("Your session is queued. It opens when your executor is ready.");
 const ended=renderToString(<SessionView {...props} task={{id:"t",state:"done"} as unknown as TaskDetail}/>);
 expect(ended).toContain("The agent process ended.");expect(queued+ended).not.toContain("terminal");
});
