import { ParentHelperSpawner } from "../../../src/update/desktop/native-parent-helper";
const spawner = new ParentHelperSpawner(0);
const child = spawner.spawn({schema:1,path:"/private/tmp/test-helper",sha256:"a".repeat(64),version:"1.0.0"});
const mode=process.argv[2];
if(mode==="abort") child.abort();
else {
 const writer=child.stdin.getWriter();await writer.write(new TextEncoder().encode("input echo λ"));await writer.close();}
const bytes=await new Response(child.stdout).text();
let exit:number|null=null,rejected=false;
try{exit=await child.exited}catch{rejected=true}
spawner.close();
console.log(JSON.stringify({bytes,exit,rejected}));
