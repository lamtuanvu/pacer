import {render} from "preact";
import {useState} from "preact/hooks";
import {LinkedTerminal} from "../../../app/src/screens/session/LinkedTerminal";
import type {SessionFileRequest,SessionFileResult} from "../../../src/session/files";

// The PTY view is stubbed by the test's build plugin; this fake service stands in for session.file.read.
const big=Array.from({length:5000},(_,index)=>[10,2500,4999].includes(index+1)?`line ${index+1} needle`:`line ${index+1}`).join("\n");
const files:Record<string,Omit<SessionFileResult,"line"|"column">>={
 "src/big.ts":{path:"src/big.ts",kind:"code",text:big,size:big.length,modified:"v1"},
 "README.md":{path:"README.md",kind:"markdown",text:"# Readme title\n\nBody text.\n",size:26,modified:"v1"},
 "docs/long.md":{path:"docs/long.md",kind:"markdown",text:Array.from({length:120},(_,index)=>`Paragraph ${index+1}.`).join("\n\n"),size:1500,modified:"v1"},
 "public/index.html":{path:"public/index.html",kind:"html",text:'<script src="https://cdn.example/a.js"></script><h1>Page</h1>',size:60,modified:"v1"},
};
// With `deferred`, reads wait until the test resolves them by path, so responses can arrive out of order.
let deferred=false;
const pending=new Map<string,()=>void>();
async function readFile({reference}:SessionFileRequest):Promise<SessionFileResult>{
 const location=/:(\d+)(?::(\d+))?$/.exec(reference);
 const path=location?reference.slice(0,location.index):reference;
 if(deferred)await new Promise<void>(resolve=>pending.set(path,resolve));
 const file=files[path];
 if(!file)throw Object.assign(new Error("File no longer exists in this session workspace"),{code:"not_found"});
 return {...file,...(location?{line:Number(location[1])}:{})};
}
let setAttempt:(attempt:number)=>void=()=>{};
function App(){
 const [attempt,set]=useState(1);setAttempt=set;
 return <LinkedTerminal id="t-files" attempt={attempt} readFile={readFile}/>;
}
const host=document.getElementById("root")!;
(globalThis as Record<string,unknown>).fileViewerTest={
 setWidth:(width:number)=>{host.style.width=`${width}px`;},
 defer:(value:boolean)=>{deferred=value;},
 resolve:(path:string)=>{pending.get(path)?.();pending.delete(path);},
 pending:()=>[...pending.keys()],
 setAttempt:(attempt:number)=>setAttempt(attempt),
 addFile:(path:string)=>{files[path]={path,kind:"code",text:"restored\n",size:9,modified:"v2"};},
};
render(<App/>,host);
