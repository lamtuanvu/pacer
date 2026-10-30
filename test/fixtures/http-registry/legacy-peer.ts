import {createInterface} from 'node:readline';
let parent:unknown;
const send=(m:unknown)=>console.log(JSON.stringify(m));
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
 if(m.method==='plugin.hello')send({jsonrpc:'2.0',id:m.id,result:{id:'http-registry-fixture',version:'1.0.0',protocol:'1.1.0',contributes:['diagnostic'],features:['httpBodyChunks']}});
 else if(m.method==='diagnostic.ping'){parent=m.id;send({jsonrpc:'2.0',id:'legacy-body',method:'capability.net.http.body.begin',params:{bytes:1},_meta:m._meta});}
 else if(m.id==='legacy-body')send({jsonrpc:'2.0',id:parent,result:{code:m.error?.data?.code,unexpectedHandle:m.result?.handle??null}});
});
