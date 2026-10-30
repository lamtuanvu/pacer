import { serve, stdinLines } from '../../../packages/plugin-sdk/src/index';
import { manifest } from '../../../plugins/pacer-notify';
let hello: unknown;
async function* input() {
  for await (const line of stdinLines()) {
    const message = JSON.parse(line);
    if (message.method === 'plugin.hello') hello = message.params.config;
    yield line;
  }
}
await serve({manifest, input:input(), handlers:{'notifier.deliver':async (_params,host)=>{
  const config=await host.config();
  return {delivered:JSON.stringify(hello)===JSON.stringify({platform:process.platform}) && JSON.stringify(config)===JSON.stringify(hello)};
}}});
