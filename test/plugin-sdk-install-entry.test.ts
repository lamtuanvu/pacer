import {expect,test} from 'bun:test';
import {parseJsonc,upsertBlock,applyUndo,backupPath} from '@pacer/plugin/install';
test('public install entry exposes pure editing and undo helpers without a host filesystem',()=>{
 const original='\ufeff{\n  // retained comment\n  "owned": true\n}\n';expect(parseJsonc(original)).toEqual({owned:true});
 const installed=upsertBlock('existing\n','managed','md');expect(applyUndo(installed,[{kind:'block',style:'md'}])).toBe('existing\n');
 const first=backupPath('/fixture/config',1700000000,()=>false);expect(backupPath('/fixture/config',1700000000,path=>path===first)).not.toBe(first);
});
