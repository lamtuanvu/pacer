import {createServer,createConnection} from "node:net";
import {writeFileSync,rmSync} from "node:fs";
const [local,remote]=process.argv.slice(2);
const server=createServer(socket=>{
  const upstream=createConnection(remote);
  socket.on("error",()=>upstream.destroy());upstream.on("error",()=>socket.destroy());
  socket.on("close",()=>upstream.destroy());upstream.on("close",()=>socket.destroy());
  socket.pipe(upstream).pipe(socket);
});
server.listen(local,()=>writeFileSync(`${local}.pid`,String(process.pid)));
const stop=()=>{server.close();rmSync(local,{force:true});rmSync(`${local}.pid`,{force:true});process.exit();};
process.on("SIGTERM",stop);
