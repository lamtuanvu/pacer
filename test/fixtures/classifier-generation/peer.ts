import { serve, stdinLines } from '../../../packages/plugin-sdk/src/index';
import { manifest } from '../../../plugins/pacer-classify/manifest';
let hello: unknown;
async function* input() {
  for await (const line of stdinLines()) {
    const message = JSON.parse(line);
    if (message.method === 'plugin.hello') {
      hello = message.params.config;
      if (process.argv.includes('--slow-hello')) await Bun.sleep(75);
    }
    yield line;
  }
}
await serve({ manifest, input: input(), handlers: {
  'classifier.ask': async (raw, host) => {
    const params = raw as any, state = JSON.parse(params.state), config = await host.config();
    let response: unknown;
    if (state.url) response = await host.http({ url: state.url, method: 'GET', timeoutMs: 4000 });
    return { value: JSON.stringify({ pid: process.pid, hello, config, selected: params.config, response }), confidence: 1, latencyMs: 0 };
  },
} });
