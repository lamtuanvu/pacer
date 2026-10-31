import {z} from 'zod';
import type {MethodDef} from './protocol';
export const FILE_WRITE_CHUNK_FEATURE='fileWriteChunks';
export const FILE_WRITE_MAX_BYTES=4194304;
export const FILE_WRITE_CHUNK_BYTES=262144;
const path=z.string().min(1).max(4096).refine(value=>!value.includes('\0'));
const handle=z.string().min(1).max(256),bytes=z.number().int().nonnegative().safe();
const mode=z.literal(0o600).optional(),ok=z.object({ok:z.literal(true)});
const text=z.string().refine(value=>Buffer.byteLength(value,'utf8')<=FILE_WRITE_MAX_BYTES,'file write exceeds 4 MiB UTF8');
const base64=z.string().min(4).max(349528).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/).refine(value=>Buffer.from(value,'base64').length<=FILE_WRITE_CHUNK_BYTES);
const method=(description:string,params:z.ZodTypeAny,result:z.ZodTypeAny=ok):MethodDef=>({description,params,result,deadlineMs:5000});
export const FS_WRITE_METHODS:Record<string,MethodDef>={
 'capability.fs.write':method('Atomically write exact host-issued private file bytes. Same bytes retain mtime; the global complete-frame limit still applies.',z.object({path,text,mode}).strict()),
 'capability.fs.mkdir':method('Create an exact host-issued private directory. Missing ancestors each require their own issued mkdir resource.',z.object({path}).strict()),
 'capability.fs.remove':method('Remove only an exact host-issued file or subtree through pinned directory descriptors.',z.object({path,recursive:z.boolean().optional()}).strict()),
 'capability.fs.beginWrite':method('Reserve one owner-bound write of at most 4 MiB; requires negotiated fileWriteChunks and prior path authority.',z.object({path,bytes:bytes.max(FILE_WRITE_MAX_BYTES),mode}).strict(),z.object({handle})),
 'capability.fs.writeChunk':method('Stage contiguous canonical base64, at most 256 KiB decoded, without publishing filesystem bytes.',z.object({handle,offset:bytes,base64}).strict(),z.object({bytes})),
 'capability.fs.commitWrite':method('Publish the complete valid UTF8 transfer only after rechecking its exact write authority.',z.object({handle}).strict()),
 'capability.fs.releaseWrite':method('Release this owning call’s pending or most recently consumed handle; cannot affect a successor transfer.',z.object({handle}).strict()),
};
export const FS_WRITE_METHOD_CAPABILITY:Record<string,'fs.write'>=Object.fromEntries(Object.keys(FS_WRITE_METHODS).map(name=>[name,'fs.write'])) as Record<string,'fs.write'>;
