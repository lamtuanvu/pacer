import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { AttachmentDelivery } from "../app/src/screens/session/Attachments";
import { Conversation, ConversationHeader } from "../app/src/screens/session/Conversation";
import { TaskContext } from "../app/src/screens/task-shared";

test("later attachment reference requires an explicit copy step and user submission", () => {
 const html=renderToString(<AttachmentDelivery name="image.png" text='Use "image.png" at "/tmp/private/image".' onCopy={()=>{}}/>);
 expect(html).toContain("Copy reference");
 expect(html).toContain("Paste into the agent’s input, then submit when ready.");
 expect(html).not.toContain("Send message");
});
test("conversation shell exposes native session identity and end action without delegated review",()=>{
 const html=renderToString(<ConversationHeader title="Build a page" repo="project" branch="pacer/task" executor="Codex · work" active busy={false} onEnd={()=>{}}/>);
 expect(html).toContain("project");expect(html).toContain("Codex · work");expect(html).toContain("End session");
 expect(html).not.toContain("Take over");expect(html).not.toContain("Review");
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
