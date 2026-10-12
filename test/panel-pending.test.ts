import {expect,test} from "bun:test";
import {runInNewContext} from "node:vm";
import {pendingClient} from "../orca-plugin/src/panel/pending";
function harness(storage=new Map<string,string>(),over:Record<string,unknown>={}) {
 let now=100000;
 const card={busy:false,setAttribute:()=>{card.busy=true;},removeAttribute:()=>{card.busy=false;}};
 const button={disabled:false,innerHTML:"Retry",closest:()=>card};
 const data:any={sequence:1,tasks:[{id:"old",state:"failed"}],rows:[{id:"codex",blocked:false}],muted:[],strategy:"default",...over};
 const status={textContent:""};let fail!:()=>void;
 const ctx:any={data,status,providerNames:{codex:"Codex"},h:(v:any)=>String(v),sessionStorage:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v)},Date:class extends Date {static now(){return now;}},sendCommand:(_c:any,_success:any,failure:any)=>{fail=failure;return true;}};
 runInNewContext(pendingClient+"\nglobalThis.api={beginAction,pendingSend,bindAction,recoverActions,actionStates,outcome};",ctx);
 return {api:ctx.api,data,status,card,button,storage,fail:()=>fail(),time:(value:number)=>{now=value;}};
}
test("retry pending state disables immediately, blocks a double click and survives reload until outcome",()=>{
 const h=harness();const c={cmd:"retry",taskId:"old",executor:"codex"};
 expect(h.api.pendingSend(h.button,c)).toBe(true);expect(h.button.disabled).toBe(true);expect(h.card.busy).toBe(true);expect(h.button.innerHTML).toContain("Retrying on Codex");expect(h.api.pendingSend(h.button,c)).toBe(false);
 const restored=harness(h.storage);restored.api.bindAction(restored.button,c);expect(restored.button.disabled).toBe(true);
 restored.data.tasks.push({id:"new",state:"queued",retryOf:"old"});restored.api.recoverActions();expect(restored.button.disabled).toBe(false);expect(restored.card.busy).toBe(false);expect(JSON.parse(h.storage.get("pacer-pending-actions")!)).toEqual({});
});
test("a bridge refusal restores action while a timeout explains the wait and permits retry",()=>{
 const h=harness(new Map(),{tasks:[{id:"old",state:"running"}]}),c={cmd:"stop",taskId:"old"};h.api.pendingSend(h.button,c);h.fail();expect(h.button.disabled).toBe(false);expect(h.button.innerHTML).toBe("Retry");
 h.api.pendingSend(h.button,c);h.time(160001);h.api.recoverActions();expect(h.button.disabled).toBe(false);expect(h.status.textContent).toContain("Still waiting for the pacer console");expect(h.api.pendingSend(h.button,c)).toBe(true);
});
for(const [cmd,label] of [["retry","Retrying"],["stop","Stopping"],["dismiss","Dismissing"],["delegate","Delegating"],["strategy-build","Starting session"],["use","Switching"],["block","Blocking"],["unblock","Unblocking"],["refresh","Refreshing"],["type","Typing command"]])test(`${cmd} has an accessible immediate pending state`,()=>{
 const h=harness();h.api.beginAction(h.button,{cmd,executor:"codex",taskId:"old"});expect(h.button.disabled).toBe(true);expect(h.button.innerHTML).toContain(label);expect(h.button.innerHTML).toContain("◐");expect(h.card.busy).toBe(true);
});

test("notification action preserves select options and completes on refreshed worker preference",()=>{
 const h=harness(new Map(),{notifications:"important"}),c={cmd:"notify-level",level:"off"};
 h.button.innerHTML='<option value="important">Important</option>';
 h.api.pendingSend(h.button,c);expect(h.button.disabled).toBe(true);expect(h.button.innerHTML).toContain("<option");
 h.data.notifications="off";h.api.recoverActions();expect(h.button.disabled).toBe(false);expect(h.status.textContent).toContain("saved");
});
