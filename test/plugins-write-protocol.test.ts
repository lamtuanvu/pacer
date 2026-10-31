import {expect,test} from 'bun:test';
import {FS_WRITE_METHODS} from '../src/plugins/write-protocol';
test('file writes bound UTF8 payload bytes and fixed private mode',()=>{
 const method=FS_WRITE_METHODS['capability.fs.write'];expect(method).toBeDefined();
 expect(method!.params.safeParse({path:'/owned/config',text:'x'.repeat(4194304),mode:0o600}).success).toBe(true);
 expect(method!.params.safeParse({path:'/owned/config',text:'界'.repeat(1398102)}).success).toBe(false);
 expect(method!.params.safeParse({path:'/owned/config',text:'x',mode:0o644}).success).toBe(false);
 expect(method!.result.parse({ok:true})).toEqual({ok:true});
});
test('file write chunks are bounded canonical binary transfers with no caller-selected resource root',()=>{
 const begin=FS_WRITE_METHODS['capability.fs.beginWrite'];expect(begin).toBeDefined();
 expect(begin!.params.safeParse({path:'/owned/config',bytes:4194304}).success).toBe(true);
 expect(begin!.params.safeParse({path:'/owned/config',bytes:4194305}).success).toBe(false);
 expect(begin!.params.safeParse({path:'/owned/config',bytes:1,root:'/outside'}).success).toBe(false);
 const chunk=FS_WRITE_METHODS['capability.fs.writeChunk'];expect(chunk).toBeDefined();
 expect(chunk!.params.safeParse({handle:'h',offset:0,base64:'YQ=='}).success).toBe(true);
 for(const base64 of ['YR==','YQ',Buffer.alloc(262145).toString('base64')])expect(chunk!.params.safeParse({handle:'h',offset:0,base64}).success).toBe(false);
});
test('all write operations require exact structured arguments and literal acknowledgments',()=>{
 for(const name of ['mkdir','remove','commitWrite','releaseWrite']){
  const method=FS_WRITE_METHODS[`capability.fs.${name}`];expect(method).toBeDefined();expect(method!.result.safeParse({ok:false}).success).toBe(false);
 }
 expect(FS_WRITE_METHODS['capability.fs.remove']!.params.safeParse({path:'/owned/config',recursive:true,force:true}).success).toBe(false);
});
