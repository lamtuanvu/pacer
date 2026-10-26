import { expect, test } from 'bun:test';
import { CoreError } from '../src/core/errors';
import { pluginRpcError } from '../src/plugins/errors';

test('plugin RPC exposes only the fixed credential reflection reason without arbitrary error data', () => {
  const error = new CoreError('capability_denied', 'HTTP response exposed an injected credential', undefined,
    {reason:'credential_reflection', secret:'must-not-cross-wire'});
  const wire = pluginRpcError(error);
  expect(wire.data).toEqual({code:'capability_denied',reason:'credential_reflection'});
  expect(JSON.stringify(wire)).not.toContain('must-not-cross-wire');
});
test('unknown reasons and reasons on other errors never cross the plugin wire', () => {
  expect(pluginRpcError(new CoreError('capability_denied','refused',undefined,{reason:'private-secret'})).data).toEqual({code:'capability_denied'});
  expect(pluginRpcError(new CoreError('invalid_input','invalid',undefined,{reason:'credential_reflection'})).data).toEqual({code:'invalid_input'});
});

import { PluginProcess } from '../src/plugins/process';
import { manifestSchema } from '../src/plugins/protocol';
import { join } from 'node:path';
test('real host-to-SDK stdio preserves the fixed classification and drops arbitrary error metadata', async () => {
  let code:'capability_denied'|'invalid_input'='capability_denied';
  let reason='credential_reflection';
  const peer=new PluginProcess({argv:[process.execPath,join(import.meta.dir,'fixtures/plugin-error-reason/peer.ts')],cwd:import.meta.dir,env:{}},{
    onRequest:async()=>{throw new CoreError(code,'safe refusal',undefined,{reason,secret:'must-not-cross-wire'});},onStderr:()=>{},onExit:()=>{},
  });
  const manifest=manifestSchema.parse({id:'fx-error-reason',version:'1.0.0',publisher:'fixture',host:'^1.3',contributes:{},capabilities:[{name:'config.get'}]});
  try {
    await peer.request('plugin.hello',{protocol:'1.3.0',pacer:'fixture',manifest,config:{},grants:['config.get']},2000);
    const first=await peer.request('diagnostic.ping',{},2000);
    expect(first).toMatchObject({observed:{code:'capability_denied',reason:'credential_reflection'}});
    expect(JSON.stringify(first)).not.toContain('must-not-cross-wire');
    reason='unknown-private-value';
    expect(await peer.request('diagnostic.ping',{},2000)).toMatchObject({observed:{code:'capability_denied'}});
    expect(JSON.stringify(await peer.request('diagnostic.ping',{},2000))).not.toContain(reason);
    code='invalid_input';reason='credential_reflection';
    expect(await peer.request('diagnostic.ping',{},2000)).toEqual({ok:true,uptimeS:0,observed:{code:'invalid_input'}});
  } finally {await peer.terminate();}
});
