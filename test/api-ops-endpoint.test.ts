import {expect, spyOn, test} from "bun:test";
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {startServer} from "../src/serve/http";
import {handleV2} from "../src/api/http";
import type {OpDeps} from "../src/api/ops";
import {loadStrategy} from "../src/config/strategy";
import {eventsSince} from "../src/api/events";
import type {ExecSpec} from "../src/exec/process";
import {fakeCtx} from "./helpers";

const secret = "sk-api-endpoint-private-value";
const externalSecret = "sk-external-provider-must-not-copy";
const models = [{id: "model-a", context: 128000, output: 16000, tools: true}];
function configured() {
  const ctx = fakeCtx();
  ctx.env = {HOME: ctx.home, PACER_HOME: ctx.pacerHome, PATH: process.env.PATH};
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), '# keep\naccounts:\n  personal: {kind: claude}\n  codex: {kind: codex}\n  external: {kind: endpoint, usage: unmetered, model: vendor/old}\nplanner: claude-code\nrouting:\n  - default: [codex, opencode#external]\n');
  return ctx;
}
function assertSafe(text: string) {
  expect(text).not.toContain(secret);
  expect(text).not.toContain(externalSecret);
}

for (const transport of ["http", "memory"]) test(`endpoint v2 operations never return, log or publish keys (${transport})`, async () => {
  const ctx = configured(), launches: ExecSpec[] = [];
  let discoveries = 0, failTest = false;
  const discover = (req: Request) => {
    expect(new URL(req.url).pathname).toBe('/v1/models');
    expect(req.headers.get('authorization')).toBe(`Bearer ${secret}`);
    discoveries++;
    return Response.json({data: [{id: 'model-a', context_length: 128000, max_output_tokens: 16000}]});
  };
  const endpoint = transport === 'http' ? Bun.serve({hostname: '127.0.0.1', port: 0, fetch: discover}) : {url: new URL('http://endpoint.invalid/'), stop(_force: boolean) {}};
  const logs: string[] = [];
  const spies = ['log', 'warn', 'error', 'info', 'debug'].map(method => spyOn(console, method as 'log').mockImplementation((...args: unknown[]) => {logs.push(args.join(' '));}));
  const opDeps: OpDeps = {endpoint: {fetch: transport === "memory" ? async (url, init) => discover(new Request(url, init)) : undefined, spawn: async spec => {
    launches.push(spec);
    expect(spec.cwd.startsWith(join(ctx.pacerHome, 'endpoints/test-'))).toBe(true);
    expect(existsSync(join(spec.cwd, '.git'))).toBe(true);
    expect(spec.env.PACER_KEY_WORK).toBe(secret);
    expect(spec.argv).not.toContain(secret);
    if (failTest) return {code: 1, stdout: '', stderr: `Authorization: Bearer ${secret}`, timedOut: false};
    writeFileSync(join(spec.cwd, 'hello.txt'), 'ok');
    return {code: 0, stdout: '', stderr: '', timedOut: false};
  }}};
  const server = transport === "http" ? startServer(() => ctx, {port: 0, pumpMs: 0, opDeps}) : {port: 0, token: "test-token", stop() {}};
  async function op(name: string, params: unknown, status = 200) {
    const request = new Request(`http://127.0.0.1:${server.port}/v2/ops/${name}`, {method: 'POST', headers: {authorization: `Bearer ${server.token}`, 'content-type': 'application/json'}, body: JSON.stringify(params)});
    const response = await (transport === 'http' ? fetch(request) : handleV2(request, {getCtx: () => ctx, opDeps}));
    const text = await response.text();
    assertSafe(text); expect(response.status).toBe(status);
    return JSON.parse(text).result;
  }
  try {
    const base_url = `${endpoint.url}v1`;
    const added = await op('account.add', {kind: 'endpoint', name: 'work', base_url, key_source: 'file', key: secret, models, usage: 'unmetered'});
    expect(added).toMatchObject({state: 'ready', account: {name: 'work', connection: {key: 'present'}}, runner: {id: 'opencode#work', model: 'pacer-work/model-a'}});
    expect(loadStrategy(ctx).routing.at(-1)!.executors).toContain('opencode#work');
    expect((await op('routing.route', {})).ranked).toEqual(expect.arrayContaining([expect.objectContaining({id: 'opencode#work'})]));
    expect(await op('account.models', {name: 'work'})).toMatchObject({listed: true, models: [{id: 'model-a', context: 128000, output: 16000}]});
    expect(await op('account.models', {base_url, key: secret})).toMatchObject({listed: true});
    expect(discoveries).toBe(2);
    expect(await op('account.test', {name: 'work'})).toMatchObject({state: 'ready', checked_at: expect.any(String)});
    const updated = [{...models[0]!, id: 'model-b'}];
    expect(await op('account.edit', {name: 'work', models: updated})).toMatchObject({state: 'not_tested', account: {connection: {models: updated}}});
    expect(loadStrategy(ctx).runners['opencode#work'].model).toBe('pacer-work/model-b');
    expect(JSON.parse(readFileSync(join(ctx.pacerHome, 'opencode/opencode.json'), 'utf8')).provider['pacer-work'].models['model-b']).toBeDefined();
    const dir = join(ctx.home, '.config/opencode'); mkdirSync(dir, {recursive: true});
    const config = join(dir, 'opencode.json');
    const original = JSON.stringify({provider: {vendor: {options: {baseURL: base_url, apiKey: externalSecret}, models: {old: {}}}}});
    writeFileSync(config, original);
    expect(await op('account.adopt', {name: 'external', key_source: 'none'})).toMatchObject({state: 'not_tested', account: {connection: {models: [{id: 'old'}]}}});
    expect(readFileSync(config, 'utf8')).toBe(original);
    expect(existsSync(join(ctx.pacerHome, 'secrets/external.key'))).toBe(false);
    failTest = true;
    expect(await op('account.test', {name: 'work'})).toMatchObject({state: 'not_working', detail: expect.stringContaining('[redacted]')});
    expect(await op('account.list', {})).toEqual(expect.arrayContaining([expect.objectContaining({name: 'work', state: 'not_working'})]));
    await op('account.add', {kind: 'endpoint', name: 'invalid', key: secret, base_url, key_source: 'file', models: [], usage: 'unmetered'}, 400);
    expect(eventsSince(ctx, 0).events.filter(e => e.type === 'config').map(e => e.data)).toEqual(Array.from({length: 5}, () => ({area: 'accounts', at: ctx.now})));
    for (const path of ['strategy.yaml', 'opencode/opencode.json', 'endpoints/state.json', 'link/outbox.jsonl']) assertSafe(readFileSync(join(ctx.pacerHome, path), 'utf8'));
    expect(readFileSync(join(ctx.pacerHome, 'secrets/work.key'), 'utf8').trim()).toBe(secret);
    expect(launches).toHaveLength(3);
    for (const spec of launches) expect(existsSync(spec.cwd)).toBe(false);
    expect(readdirSync(join(ctx.pacerHome, 'endpoints')).some(p => p.startsWith('test-'))).toBe(false);
    assertSafe(logs.join('\n'));
  } finally {server.stop(); endpoint.stop(true); for (const spy of spies) spy.mockRestore();}
});

// The registry test also runs where the sandbox disallows listening on loopback.
test("endpoint registry validates inputs, reuses stored keys and publishes only safe account events", async () => {
  const {callOp} = await import('../src/api/ops');
  const ctx = configured(); let tested = 0;
  const deps = {endpoint: {
    spawn: async (spec: ExecSpec) => {tested++; expect(spec.env.PACER_KEY_WORK).toBe(secret); writeFileSync(join(spec.cwd, 'hello.txt'), 'ok'); return {code: 0, stdout: '', stderr: '', timedOut: false};},
    fetch: async (_url: string, init?: RequestInit) => {expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${secret}`); return Response.json({data: [{id: 'model-a'}]});},
  }};
  const call = async (name: string, params: unknown) => {
    const result = await callOp(ctx, name, params, deps); assertSafe(JSON.stringify(result)); return result;
  };
  expect(await call('account.add', {kind: 'endpoint', name: 'work', base_url: 'http://endpoint.invalid/v1', key_source: 'file', key: secret, models, usage: 'metered', weekly_tokens: 1000000})).toMatchObject({state: 'ready'});
  expect(await call('account.models', {name: 'work'})).toMatchObject({listed: true, models: [{id: 'model-a'}]});
  expect(await call('account.test', {name: 'work'})).toMatchObject({state: 'ready'});
  expect(tested).toBe(2);
  expect(await call('account.edit', {name: 'work', models: [{...models[0]!, id: 'model-b'}]})).toMatchObject({state: 'not_tested'});
  expect(loadStrategy(ctx).runners['opencode#work'].model).toBe('pacer-work/model-b');
  const dir = join(ctx.home, '.config/opencode'); mkdirSync(dir, {recursive: true});
  const path = join(dir, 'opencode.json');
  const original = JSON.stringify({provider: {vendor: {options: {baseURL: 'http://endpoint.invalid/v1', apiKey: externalSecret}, models: {old: {}}}}});
  writeFileSync(path, original);
  expect(await call('account.adopt', {name: 'external', key_source: 'none'})).toMatchObject({account: {connection: {models: [{id: 'old'}]}}, state: 'not_tested'});
  expect(readFileSync(path, 'utf8')).toBe(original);
  expect(eventsSince(ctx, 0).events.map(e => e.data)).toEqual(Array.from({length: 4}, () => ({area: 'accounts', at: ctx.now})));
  const before = readFileSync(join(ctx.pacerHome, 'strategy.yaml'), 'utf8');
  for (const params of [
    {models: []}, {usage: 'reactive'}, {base_url: 'file:///invalid'}, {key_source: 'argv'}, {models: [{id: 'bad', context: -1, output: 10, tools: true}]},
  ]) await expect(call('account.add', {kind: 'endpoint', name: 'invalid', base_url: 'http://endpoint.invalid/v1', key_source: 'file', key: secret, models, usage: 'unmetered', ...params})).rejects.toMatchObject({code: 'invalid_input'});
  expect(readFileSync(join(ctx.pacerHome, 'strategy.yaml'), 'utf8')).toBe(before);
  expect(eventsSince(ctx, 0).events).toHaveLength(4);
  for (const path of ['strategy.yaml', 'opencode/opencode.json', 'endpoints/state.json', 'link/outbox.jsonl']) assertSafe(readFileSync(join(ctx.pacerHome, path), 'utf8'));
});

test.skipIf(!Bun.which('opencode'))("real OpenCode creates hello.txt through the generated provider and sends its stored key", async () => {
  const {addEndpoint} = await import('../src/core/endpoints');
  const ctx = configured();
  // Keep OpenCode's config, cache, auth, logs and data under the isolated HOME.
  ctx.env = {...ctx.env, XDG_CONFIG_HOME: join(ctx.home, '.config'), XDG_DATA_HOME: join(ctx.home, '.local/share'), XDG_CACHE_HOME: join(ctx.home, '.cache'), XDG_STATE_HOME: join(ctx.home, '.local/state'), OPENCODE_DISABLE_MODELS_FETCH: 'true'};
  let authorized = 0, toolRequested = false;
  const endpoint = Bun.serve({hostname: '127.0.0.1', port: 0, async fetch(req) {
    if (new URL(req.url).pathname !== '/v1/chat/completions') return new Response('not found', {status: 404});
    if (req.headers.get('authorization') === `Bearer ${secret}`) authorized++;
    const body = await req.json() as {stream?: boolean; tools?: {function: {name: string}}[]; messages: {role: string}[]};
    const write = body.tools?.find(t => t.function.name === 'write');
    const callTool = !!write && !body.messages.some(m => m.role === 'tool');
    if (callTool) toolRequested = true;
    const message = callTool
      ? {role: 'assistant', content: null, tool_calls: [{id: 'call_write_hello', type: 'function', function: {name: 'write', arguments: JSON.stringify({path: join(ctx.pacerHome, 'endpoints', readdirSync(join(ctx.pacerHome, 'endpoints')).find(path => path.startsWith('test-'))!, 'hello.txt'), content: 'ok'})}}]}
      : {role: 'assistant', content: 'Created hello.txt.'};
    const finish_reason = callTool ? 'tool_calls' : 'stop';
    const base = {id: 'chatcmpl-endpoint-test', created: 1, model: 'model-a'};
    if (!body.stream) return Response.json({...base, object: 'chat.completion', choices: [{index: 0, message, finish_reason}], usage: {prompt_tokens: 20, completion_tokens: 20, total_tokens: 40}});
    const delta = callTool ? {...message, tool_calls: message.tool_calls!.map((tool, index) => ({...tool, index}))} : message;
    const chunks = [
      {...base, object: 'chat.completion.chunk', choices: [{index: 0, delta, finish_reason: null}]},
      {...base, object: 'chat.completion.chunk', choices: [{index: 0, delta: {}, finish_reason}], usage: {prompt_tokens: 20, completion_tokens: 20, total_tokens: 40}},
    ];
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {headers: {'content-type': 'text/event-stream'}});
  }});
  try {
    const result = await addEndpoint(ctx, {name: 'work', base_url: `${endpoint.url}v1`, key_source: 'file', key: secret, models, usage: 'unmetered'});
    assertSafe(JSON.stringify(result));
    // The shared test task records Ready only after reading exactly "ok" from hello.txt.
    expect(result).toMatchObject({state: 'ready'});
    expect(authorized).toBeGreaterThan(0); expect(toolRequested).toBe(true);
    expect(readdirSync(join(ctx.pacerHome, 'endpoints')).filter(p => p.startsWith('test-'))).toEqual([]);
  } finally {endpoint.stop(true);}
}, 150000);
