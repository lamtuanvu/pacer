/** Exact fresh-command asset cleanup; transaction/recovery assets never enter this API. */
import {createHash} from "node:crypto";
import {closeSync,constants,fstatSync,lstatSync,openSync,readdirSync,readSync,realpathSync,rmdirSync,unlinkSync} from "node:fs";
import {basename,dirname} from "node:path";
import {processIdentity,sameProcess,type ProcessIdentity} from "./process-identity";
function inspect(path:string){
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||stat.mode&0o077||stat.size>128*1024*1024)throw Error("Ambiguous command asset");
  const digest=createHash("sha256"),buffer=Buffer.alloc(65536);let size=0;
  for(;;){const n=readSync(fd,buffer,0,buffer.length,null);if(!n)break;size+=n;if(size>128*1024*1024)throw Error("Command asset exceeds bound");digest.update(buffer.subarray(0,n));}
  const after=fstatSync(fd);if(after.dev!==stat.dev||after.ino!==stat.ino||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw Error("Command asset changed");
  return{dev:stat.dev,ino:stat.ino,hash:digest.digest("hex")};
 }finally{closeSync(fd);}
}
export function freshHelperCleanup(path:string,child:ProcessIdentity,observe:(pid:number)=>ProcessIdentity|null=processIdentity):()=>void{
 const dir=dirname(path),name=basename(path),directory=lstatSync(dir),asset=inspect(path);
 if(name!=="pacer-update-helper"||realpathSync(dir)!==dir||!directory.isDirectory()||directory.isSymbolicLink()||directory.uid!==process.getuid?.()||directory.mode&0o077)throw Error("Ambiguous command directory");
 return()=>{
  try{
   if(sameProcess(child,observe(child.pid)))return;
   const now=lstatSync(dir);if(!now.isDirectory()||now.isSymbolicLink()||now.uid!==directory.uid||now.dev!==directory.dev||now.ino!==directory.ino||now.mode&0o077||realpathSync(dir)!==dir)return;
   const names=readdirSync(dir);if(names.length!==1||names[0]!==name)return;
   const current=inspect(path);if(current.dev!==asset.dev||current.ino!==asset.ino||current.hash!==asset.hash)return;
   const last=lstatSync(path);if(last.dev!==asset.dev||last.ino!==asset.ino||last.isSymbolicLink())return;
   unlinkSync(path);rmdirSync(dir);
  }catch{/* Keep ambiguous assets; never broaden cleanup or change update outcome. */}
 };
}
