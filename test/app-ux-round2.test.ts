import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { executorLabel, executorCaption } from "../app/src/model/tasks";
import { draftStorage } from "../app/src/model/draft";

test("drafts restore edits, clear on success, and allow new edits after clearing", () => {
 const values = new Map<string,string>();
 const storage = {getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);},removeItem:(k:string)=>{values.delete(k);}};
 const session=draftStorage("delegate",{goal:"",repo:""},storage);
 session.write({goal:"Previous goal",repo:"/repo"});
 expect(session.read()).toEqual({goal:"Previous goal",repo:"/repo"});
 session.clear();
 expect(values.has("delegate")).toBe(false);
 expect(session.read()).toEqual({goal:"",repo:""});
 session.write({goal:"New goal",repo:"/new"});
 expect(session.read().goal).toBe("New goal");
 values.set("delegate",'{"goal":42,"repo":"/repo","key":"secret"}');
 expect(session.read()).toEqual({goal:"",repo:"/repo"});
 values.set("delegate","invalid json");
 expect(session.read()).toEqual({goal:"",repo:""});
 const unavailable=draftStorage("wizard",{name:""},{getItem:()=>{throw Error();},setItem:()=>{throw Error();},removeItem:()=>{throw Error();}});
 expect(unavailable.read()).toEqual({name:""});
 expect(()=>{unavailable.write({name:"ok"});unavailable.clear();}).not.toThrow();
});

test("all screen form controls have IDs and a text label or aria-label", () => {
 const directory=new URL("../app/src/screens/",import.meta.url);
 for(const file of readdirSync(directory).filter(f=>f.endsWith(".tsx"))) {
  const source=readFileSync(new URL(file,directory),"utf8");
  for(const match of source.matchAll(/<(input|select|textarea)\b([^>]*?)(?=>)/g)) {
   const id=match[2]!.match(/\bid=("[^"]+"|\{`[^`]+`\})/)?.[1];
   expect(id,`${file}: missing ID`).toBeDefined();
   const prefix=source.slice(0,match.index), label=prefix.lastIndexOf("<label");
   const labelBody=source.slice(label,source.indexOf("</label>",match.index));
   const target=prefix.slice(label).match(/htmlFor=("[^"]+"|\{`[^`]+`\})/)?.[1];
   const wrapped=label>prefix.lastIndexOf("</label>") && target===id && /[A-Za-z]/.test(labelBody);
   expect(/aria-label=/.test(match[2]!)||wrapped,`${file}: ${match[0]}`).toBe(true);
  }
 }
});

test("endpoint titles and captions do not duplicate their kind", () => {
 const account={name:"byteplus",kind:"endpoint" as const,connection:{base_url_host:"api.example.com",models:[]}};
 expect(executorLabel("opencode#byteplus",[account])).toBe("byteplus");
 expect(executorCaption(account)).toBe("Model endpoint · api.example.com");
 expect(executorCaption({name:"legacy",kind:"endpoint"})).toBe("External OpenCode provider");
 expect(executorCaption()).toBe("Agent CLI");
});
