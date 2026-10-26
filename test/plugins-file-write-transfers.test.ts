import {afterEach,expect,test} from 'bun:test';
import {createCallAuthority,type CallAuthority} from '../src/plugins/authority';
import {fileWriteTransfers} from '../src/plugins/file-write-transfers';
import {fakeCtx} from './helpers';
const owners:CallAuthority[]=[];
afterEach(async()=>{await Promise.all(owners.splice(0).map(owner=>owner.revoke()));});
function fixture(grants=['fs.write']){
 const owner=createCallAuthority(fakeCtx(),{reads:[],commands:[],stores:[]},{deadlineMs:Date.now()+5000,grants});owners.push(owner);
 const authorized:string[]=[],writes:{path:string;text:string;mode?:number}[]=[];
 const transfers=fileWriteTransfers(owner,{authorize:path=>{authorized.push(path);},write:async(path,text,mode)=>{writes.push({path,text,mode});return {ok:true};}});
 return {owner,transfers,authorized,writes};
}
test('large UTF8 writes stage bounded chunks and publish only the exact complete text',async()=>{
 const f=fixture(),text='\ufeff'+ '界'.repeat(400000),bytes=Buffer.from(text);
 const {handle}=await f.transfers.begin('/owned/config',bytes.length,0o600);
 expect(f.authorized).toEqual(['/owned/config']);
 for(let offset=0;offset<bytes.length;offset+=262144){const part=bytes.subarray(offset,offset+262144);expect(await f.transfers.append(handle,offset,part.toString('base64'))).toEqual({bytes:offset+part.length});}
 expect(f.writes).toEqual([]);
 expect(await f.transfers.commit(handle)).toEqual({ok:true});
 expect(f.writes).toEqual([{path:'/owned/config',text,mode:0o600}]);
 await expect(f.transfers.commit(handle)).rejects.toMatchObject({code:'capability_denied'});
});
test('one pending transfer belongs to one owner and releasing it admits a successor',async()=>{
 const a=fixture(),b=fixture(),{handle}=await a.transfers.begin('/owned/a',1);
 await expect(a.transfers.begin('/owned/b',1)).rejects.toMatchObject({code:'conflict'});
 await expect(b.transfers.append(handle,0,'YQ==')).rejects.toMatchObject({code:'capability_denied'});
 await a.transfers.release(handle);
 const next=await a.transfers.begin('/owned/b',0);expect(next.handle).not.toBe(handle);
 await a.transfers.commit(next.handle);expect(a.writes).toEqual([{path:'/owned/b',text:'',mode:undefined}]);expect(b.writes).toEqual([]);
});
test('invalid limits, encodings, offsets and incomplete data never reach filesystem writes',async()=>{
 const f=fixture();
 for(const bytes of [-1,1.5,4194305])await expect(f.transfers.begin('/owned/a',bytes)).rejects.toMatchObject({code:'invalid_input'});
 await expect(f.transfers.begin('/owned/a',1,0o644)).rejects.toMatchObject({code:'invalid_input'});
 const {handle}=await f.transfers.begin('/owned/a',2);
 for(const data of ['YQ','YR==','YQ==\n',Buffer.alloc(262145).toString('base64')])await expect(f.transfers.append(handle,0,data)).rejects.toMatchObject({code:'invalid_input'});
 await expect(f.transfers.append(handle,1,'YQ==')).rejects.toMatchObject({code:'invalid_input'});
 await f.transfers.append(handle,0,'YQ==');
 await expect(f.transfers.commit(handle)).rejects.toMatchObject({code:'invalid_input'});
 await f.transfers.append(handle,1,'/w==');
 await expect(f.transfers.commit(handle)).rejects.toMatchObject({code:'invalid_input'});
 expect(f.writes).toEqual([]);
});
test('reply envelope refusal happens before a handle is reserved or a chunk cursor advances',async()=>{
 const f=fixture();await expect(f.transfers.begin('/owned/a',1,undefined,()=>false)).rejects.toMatchObject({code:'invalid_input'});
 const {handle}=await f.transfers.begin('/owned/a',1);
 await expect(f.transfers.append(handle,0,'YQ==',()=>false)).rejects.toMatchObject({code:'invalid_input'});
 expect(await f.transfers.append(handle,0,'YQ==')).toEqual({bytes:1});
 await f.transfers.commit(handle);expect(f.writes[0]!.text).toBe('a');
});
test('missing grants and revocation cannot reserve or publish a transfer',async()=>{
 const denied=fixture([]);await expect(denied.transfers.begin('/owned/a',1)).rejects.toMatchObject({code:'capability_denied'});expect(denied.authorized).toEqual([]);
 const f=fixture(),{handle}=await f.transfers.begin('/owned/a',1);await f.transfers.append(handle,0,'YQ==');await f.owner.revoke();
 await expect(f.transfers.commit(handle)).rejects.toMatchObject({code:'capability_denied'});expect(f.writes).toEqual([]);
});
test('revocation waits for in-flight authorization and fences its late completion',async()=>{
 let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>{entered=r;});
 // A separate owner ensures the production factory captures these callbacks once.
 const owner=createCallAuthority(fakeCtx(),{reads:[],commands:[],stores:[]},{deadlineMs:Date.now()+5000,grants:['fs.write']});owners.push(owner);
 const transfers=fileWriteTransfers(owner,{authorize:async()=>{entered();await new Promise<void>(r=>{release=r;});},write:async()=>{throw Error('must not write');}});
 const pending=transfers.begin('/owned/a',1);await ready;let settled=false;const revoked=owner.revoke().then(()=>{settled=true;});await Promise.resolve();expect(settled).toBe(false);release();
 await expect(pending).rejects.toMatchObject({code:'capability_denied'});await revoked;expect(settled).toBe(true);
});
test('cleanup of the most recently consumed handle is idempotent and cannot release a successor',async()=>{
 const f=fixture(),first=await f.transfers.begin('/owned/a',0);await f.transfers.commit(first.handle);
 expect(await f.transfers.release(first.handle)).toEqual({ok:true});
 const next=await f.transfers.begin('/owned/b',1);expect(await f.transfers.release(first.handle)).toEqual({ok:true});
 await f.transfers.append(next.handle,0,'Yg==');await f.transfers.commit(next.handle);
 expect(f.writes.map(write=>write.text)).toEqual(['','b']);
 await expect(f.transfers.release(first.handle)).rejects.toMatchObject({code:'capability_denied'});
 expect(await f.transfers.release(next.handle)).toEqual({ok:true});
});
