/** Fixed signed transport library. No caller-selected library or search path. */
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DarwinAuthority } from "./native-os";
import { parseBundleRelease } from "./identity";
const denied=()=>Error("Verified native transport shim unavailable");
export const NATIVE_SHIM_ABI = 1;
export const NATIVE_SHIM_SYMBOLS = {
  pacer_descriptor_flags:{args:[FFIType.i32],returns:FFIType.i32},
  pacer_native_transport_abi:{args:[],returns:FFIType.i32},
  pacer_receive_listener:{args:[FFIType.i32],returns:FFIType.i32},
  pacer_receive_helper_channel:{args:[FFIType.i32],returns:FFIType.i32},
  pacer_receive_parent_channels:{args:[FFIType.i32,FFIType.ptr],returns:FFIType.i32},
  pacer_acknowledge_parent:{args:[FFIType.i32],returns:FFIType.i32},
  pacer_request_helper:{args:[FFIType.i32,FFIType.ptr,FFIType.u32,FFIType.ptr],returns:FFIType.i32},
} as const;
export function nativeShimLocation(executable:string):{path:string;app:string|null} {
  if(realpathSync(executable)!==executable)throw denied();
  const resources=dirname(executable),contents=dirname(resources),app=dirname(contents);
  if(["pacer","pacer-core"].includes(basename(executable))&&basename(resources)==="Resources"&&basename(contents)==="Contents"&&app.endsWith(".app"))return{path:join(contents,"Frameworks/libpacer-native.dylib"),app};
  return{path:join(resources,"libpacer-native.dylib"),app:null};
}
export function loadNativeShim() {
 const authority=DarwinAuthority.configured();if(!authority)throw denied();
 const executable=realpathSync(process.execPath),location=nativeShimLocation(executable);
 const path=location.path;
 if(realpathSync(path)!==path)throw denied();
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try {
  const before=fstatSync(fd),header=Buffer.alloc(32);
  if(!before.isFile()||before.nlink!==1||before.uid!==process.getuid?.()||before.mode&0o022||!(before.mode&0o100)||before.size<32||before.size>16*1024*1024||readSync(fd,header,0,32,0)!==32)throw denied();
  const cpu=process.arch==="arm64"?0x0100000c:process.arch==="x64"?0x01000007:0;
  if(!cpu||header.readUInt32LE(0)!==0xfeedfacf||header.readUInt32LE(4)!==cpu||header.readUInt32LE(12)!==6)throw denied();
  authority.verifyStatic(executable,"cli");
  if(location.app){
   authority.verifyStatic(location.app,"desktop");
   if(parseBundleRelease(JSON.parse(readFileSync(join(location.app,"Contents/Resources/pacer-release.json"),"utf8"))).nativeTransportAbi!==NATIVE_SHIM_ABI)throw denied();
  }
  authority.verifyNativeShim(path);
  const after=lstatSync(path);
  if(after.isSymbolicLink()||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.mode!==after.mode)throw denied();
  const library=dlopen(path,NATIVE_SHIM_SYMBOLS);
  try{if(library.symbols.pacer_native_transport_abi()!==NATIVE_SHIM_ABI)throw denied();return library;}catch(error){library.close();throw error;}
 }finally{closeSync(fd);}
}
