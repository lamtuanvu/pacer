import {createInterface} from "node:readline";
const send=(m:object)=>console.log(JSON.stringify({jsonrpc:"2.0",...m}));
for await(const line of createInterface({input:process.stdin})){
 const m=JSON.parse(line);
 if(m.method==="plugin.hello")send({id:m.id,result:{protocol:"1.1.0",id:m.params.manifest.id,version:m.params.manifest.version,contributes:["usage"],features:["chunkedResults"]}});
 else if(m.method==="usage.read")send({id:"read-"+m.id,method:"capability.fs.read",params:{path:m.params.accountHome+"/telemetry.json"},_meta:m._meta});
 else if(typeof m.id==="string"&&m.id.startsWith("read-"))send({id:Number(m.id.slice(5)),result:{windows:[],capturedAt:100,stale:false,marker:m.error?"caught-capability-error":"received-capability-success",code:m.error?.data?.code??null}});
}
