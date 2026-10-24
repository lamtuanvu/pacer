import { StringDecoder } from 'node:string_decoder';
import { ApiError } from '../api/client-types';
import { FrameType, WireDecoder, wire } from '../session/framing';
import { serviceEndpoint, type ServiceEndpoint } from './service-endpoint';
import type { Ctx } from '../types';
import type { Result } from './types';

async function* stdinLines(): AsyncIterable<string> {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  for await (const bytes of process.stdin) {
    pending += decoder.write(Buffer.from(bytes));
    if (Buffer.byteLength(pending) > 256 * 1024) throw new ApiError('too_large', 'Session input line exceeds 256 KiB');
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) { yield pending.slice(0, end); pending = pending.slice(end + 1); }
  }
  pending += decoder.end();
  if (pending) yield pending;
}

/** A persistent authenticated viewer. Closing releases control through the existing host. */
export async function sessionIoCommand(args: string[], ctx: Ctx, deps: {
  endpoint?: () => Promise<ServiceEndpoint>;
  input?: AsyncIterable<string>;
  emit?: (event: Record<string, unknown>) => void;
} = {}): Promise<Result> {
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [id, ...rest] = args;
    if (!id || !/^[\w-]{1,128}$/.test(id)) throw new ApiError('invalid_input', 'session io requires a task ID');
    let timeout = 600, from: number | undefined;
    const flags = new Set<string>();
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      if (!['--json', '--control', '--force', '--from', '--timeout'].includes(flag) || flags.has(flag)) throw new ApiError('invalid_input', 'Unknown or repeated session io argument');
      flags.add(flag);
      if (flag === '--from' || flag === '--timeout') {
        const value = rest[++i];
        if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ApiError('invalid_input', 'Offsets and timeout must be integers');
        if (flag === '--from') from = Number(value); else timeout = Number(value);
      }
    }
    if (timeout < 1 || timeout > 3000 || (flags.has('--force') && !flags.has('--control'))) throw new ApiError('invalid_input', 'Timeout must be 1–3000 seconds; --force requires --control');
    const endpoint = await (deps.endpoint ?? (() => serviceEndpoint(ctx)))();
    const url = new URL(`/v3/tasks/${id}/session`, endpoint.base);
    url.protocol = 'ws:';
    if (from !== undefined) url.searchParams.set('from', String(from));
    const Socket = globalThis.WebSocket as unknown as {new(url: string, options: Bun.WebSocketOptions): WebSocket};
    socket = new Socket(url.href, {headers: {Authorization: `Bearer ${endpoint.token}`}});
    socket.binaryType = 'arraybuffer';
    const ws = socket, emit = deps.emit ?? (event => { process.stdout.write(`${JSON.stringify(event)}\n`); });
    let controlling = false, finished = false;
    let succeed!: () => void, fail!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => { succeed = () => { finished = true; resolve(); }; fail = error => { finished = true; reject(error); }; });
    // Install rejection handling before opening/reading: async input can be idle.
    void done.catch(() => {});
    let controlResolve: (() => void) | undefined, controlReject: ((error: Error) => void) | undefined;
    const take = (force: boolean) => new Promise<void>((resolve, reject) => {
      controlResolve = resolve; controlReject = reject;
      ws.send(JSON.stringify({type: 'take', ...(force ? {force: true} : {})}));
    });
    const decoder = new WireDecoder();
    ws.onmessage = event => {
      try {
        if (typeof event.data !== 'string') {
          for (const frame of decoder.push(new Uint8Array(event.data as ArrayBuffer))) {
            if (frame.type !== FrameType.output) throw new ApiError('invalid_input', 'Unexpected binary session frame');
            emit({type: 'output', task_id: id, base64: frame.data.toString('base64')});
          }
          return;
        }
        const value = JSON.parse(event.data);
        if (value.type === 'control') {
          controlling = value.you === true;
          if (controlling) { controlResolve?.(); controlResolve = undefined; controlReject = undefined; }
          else if (['refused', 'read-only'].includes(value.reason)) {
            controlReject?.(new ApiError('conflict', 'Session control was refused', 'Another viewer may hold control; use --force only when requested.'));
            controlResolve = undefined; controlReject = undefined;
          }
        }
        emit({...value, task_id: id});
        if (value.type === 'exit') succeed();
      } catch (error) { fail(error instanceof Error ? error : Error('Invalid session frame')); }
    };
    ws.onerror = () => fail(new ApiError('internal', 'Session connection failed'));
    ws.onclose = () => { if (!finished) fail(new ApiError('internal', 'Session connection closed before exit or detach')); };
    timer = setTimeout(() => fail(new ApiError('conflict', 'Session observation timed out; the session continues')), timeout * 1000);
    const opened = new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.addEventListener('error', () => reject(new ApiError('internal', 'Session handshake failed')), {once: true});
    });
    await Promise.race([opened, done]);
    if (!finished) {
      ws.send(JSON.stringify({type: 'hello', v: 1, client: 'cli', label: 'agent', cols: 120, rows: 40, ...(from !== undefined ? {from} : {})}));
      const pump = async () => {
        if (flags.has('--control')) await Promise.race([take(flags.has('--force')), done]);
        for await (const line of deps.input ?? stdinLines()) {
          if (finished) break;
          if (Buffer.byteLength(line) > 256 * 1024) throw new ApiError('too_large', 'Session input line exceeds 256 KiB');
          let value: any;
          try { value = JSON.parse(line); } catch { throw new ApiError('invalid_input', 'Session input must be newline-delimited JSON'); }
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('invalid_input', 'Invalid session message');
          if (value.type === 'detach') { succeed(); break; }
          if (value.type === 'take') { await Promise.race([take(value.force === true), done]); continue; }
          if (value.type === 'release') { ws.send(JSON.stringify({type: 'release'})); controlling = false; continue; }
          if (!controlling) throw new ApiError('conflict', 'Acquire session control before sending input or resizing');
          if (value.type === 'input' && ((typeof value.text === 'string' && value.base64 === undefined) || (value.text === undefined && typeof value.base64 === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64)))) {
            ws.send(new Uint8Array(wire(FrameType.input, value.base64 !== undefined ? Buffer.from(value.base64, 'base64') : Buffer.from(value.text))));
          } else if (value.type === 'size' && Number.isInteger(value.cols) && Number.isInteger(value.rows) && value.cols > 0 && value.cols <= 1000 && value.rows > 0 && value.rows <= 500) {
            ws.send(JSON.stringify({type: 'size', cols: value.cols, rows: value.rows}));
          } else throw new ApiError('invalid_input', 'Use input, size, take, release or detach messages');
        }
      };
      void pump().catch(error => fail(error instanceof Error ? error : Error('Session input failed')));
      await done;
    }
    return {code: 0, out: '', err: ''};
  } catch (error) {
    const body = error instanceof ApiError ? {code: error.code, message: error.message, ...(error.hint ? {hint: error.hint} : {})} : {code: 'internal', message: 'Session I/O failed'};
    return {code: body.code === 'invalid_input' || body.code === 'too_large' ? 2 : 1, out: '', err: JSON.stringify({error: body})};
  } finally { clearTimeout(timer); socket?.close(); if (!deps.input) process.stdin.destroy(); }
}
