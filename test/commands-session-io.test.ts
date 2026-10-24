import { expect, test } from 'bun:test';
import { sessionIoCommand } from '../src/commands/session-io';
import { fakeCtx } from './helpers';
import { FrameType, wire, WireDecoder } from '../src/session/framing';

test('session io authenticates, acquires control and exchanges binary input/output as JSON', async () => {
  const input: string[] = [], output: any[] = [];
  let auth = '';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(req, s) { auth = req.headers.get('authorization') ?? ''; if (s.upgrade(req)) return; return new Response('', {status: 400}); },
    websocket: { message(ws, data) {
      if (typeof data === 'string') {
        const value = JSON.parse(data);
        if (value.type === 'hello') ws.send(JSON.stringify({type: 'control', you: false}));
        if (value.type === 'take') ws.send(JSON.stringify({type: 'control', you: true}));
      } else for (const frame of new WireDecoder().push(data)) if (frame.type === FrameType.input) {
        input.push(frame.data.toString()); ws.send(wire(FrameType.output, Buffer.from('got it'))); ws.send(JSON.stringify({type: 'exit', code: 0}));
      }
    } },
  });
  try {
    async function* lines() { yield '{"type":"input","text":"hello\\r"}'; }
    const result = await sessionIoCommand(['task-1', '--control', '--timeout', '2', '--json'], fakeCtx(), { endpoint: async () => ({base: `http://127.0.0.1:${server.port}`, token: 'fixture'}), input: lines(), emit: value => output.push(value) });
    expect(result.code).toBe(0);
    expect(auth).toBe('Bearer fixture');
    expect(input).toEqual(['hello\r']);
    expect(output.find(x => x.type === 'output').base64).toBe(Buffer.from('got it').toString('base64'));
  } finally { server.stop(true); }
});
test('session io refuses input without control and does not claim it was applied', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req, s) { if(s.upgrade(req)) return; return new Response(); }, websocket: { message(ws) { ws.send(JSON.stringify({type:'control',you:false,reason:'refused',controller:'another'})); } } });
  try {
    async function* lines() { yield '{"type":"input","text":"must not send"}'; }
    const result = await sessionIoCommand(['task-1', '--control', '--timeout', '2', '--json'], fakeCtx(), { endpoint: async () => ({base:`http://127.0.0.1:${server.port}`,token:'fixture'}), input:lines(), emit:()=>{} });
    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.err).error.code).toBe('conflict');
  } finally { server.stop(true); }
});

test('real stdin preserves split UTF-8 and exits on a session exit while the pipe stays open', async () => {
  let received = '';
  const server = Bun.serve({hostname:'127.0.0.1',port:0,
    fetch(req,s) { if(s.upgrade(req)) return; return new Response(); },
    websocket:{ message(ws,data) {
      if (typeof data === 'string') { if(JSON.parse(data).type==='take') ws.send('{"type":"control","you":true}'); }
      else for(const frame of new WireDecoder().push(data)) if(frame.type===FrameType.input) { received=frame.data.toString(); ws.send('{"type":"exit","code":0}'); }
    }},
  });
  const module = new URL('../src/commands/session-io.ts', import.meta.url).href;
  const code = `import {sessionIoCommand} from ${JSON.stringify(module)}; const result=await sessionIoCommand(['task','--control','--timeout','2','--json'],{}, {endpoint:async()=>({base:'http://127.0.0.1:${server.port}',token:'fixture'})}); process.exitCode=result.code;`;
  const child = Bun.spawn([process.execPath,'-e',code],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});
  try {
    const bytes=Buffer.from('{"type":"input","text":"你好"}\n');
    const split=bytes.indexOf(Buffer.from('你'))+1;
    child.stdin.write(bytes.subarray(0,split)); await child.stdin.flush();
    await Bun.sleep(30);
    child.stdin.write(bytes.subarray(split)); await child.stdin.flush();
    const exit=await Promise.race([child.exited,Bun.sleep(4000).then(()=>{child.kill();return -1;})]);
    expect(exit).toBe(0);
    expect(received).toBe('你好');
  } finally { child.kill(); server.stop(true); }
});
