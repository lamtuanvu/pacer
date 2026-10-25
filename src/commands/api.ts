import { assertCallerCanInvoke } from "../api/caller-policy";
import { open } from 'node:fs/promises';
import { connectClient } from '../api/client';
import { ApiError, type ApiClient } from '../api/client-types';
import type { Ctx } from '../types';
import type { Result } from './types';

export const API_USAGE = 'api list|describe <op>|call <op> [--json] [--params-file <path|->]';
export const MAX_PARAMS_BYTES = 256 * 1024;

/** Read at most limit+1 bytes, including when the input is a pipe or growing file. */
export async function readParams(path: string): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  const consume = (chunk: Buffer) => {
    total += chunk.length;
    if (total > MAX_PARAMS_BYTES) throw new ApiError('too_large', 'Parameters exceed 256 KiB');
    chunks.push(chunk);
  };
  if (path === '-') {
    for await (const chunk of process.stdin) consume(Buffer.from(chunk));
  } else {
    const handle = await open(path, 'r').catch(() => { throw new ApiError('invalid_input', 'Cannot read parameter file'); });
    try {
      while (true) {
        const buffer = Buffer.alloc(Math.min(16384, MAX_PARAMS_BYTES + 1 - total));
        const { bytesRead } = await handle.read(buffer);
        if (!bytesRead) break;
        consume(buffer.subarray(0, bytesRead));
      }
    } finally { await handle.close(); }
  }
  return Buffer.concat(chunks).toString('utf8');
}

function secrets(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([name, item]) =>
    /(^|_)(key|token|secret|password|credential)$/i.test(name) && typeof item === 'string' && item.length
      ? [item] : secrets(item));
}

export async function apiCommand(args: string[], ctx: Ctx, deps: {
  connect?: () => Promise<ApiClient>;
  read?: (path: string) => Promise<string>;
} = {}): Promise<Result> {
  const json = args.includes('--json');
  let client: ApiClient | undefined;
  let sensitive: string[] = [];
  try {
    const [action, ...rest] = args;
    if (!['list', 'describe', 'call'].includes(action)) throw new ApiError('invalid_input', `usage: pacer ${API_USAGE}`);
    const flags: Record<string, string | true> = {};
    let name: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      if (!flag.startsWith('-') && !name && action !== 'list') { name = flag; continue; }
      const allowed = ['--json', ...(action === 'list' ? ['--prefix', '--search'] : action === 'call' ? ['--params', '--params-file'] : [])];
      if (!allowed.includes(flag) || Object.hasOwn(flags, flag)) throw new ApiError('invalid_input', 'Unknown or repeated argument', API_USAGE);
      if (flag === '--json') flags[flag] = true;
      else {
        const value = rest[++i];
        if (!value || value.startsWith('--')) throw new ApiError('invalid_input', 'Argument requires a value', API_USAGE);
        flags[flag] = value;
      }
    }
    if (action !== 'list' && (!name || !/^[a-z][a-zA-Z0-9_.]*$/.test(name) || name.length > 128)) throw new ApiError('invalid_input', 'An operation name is required', 'Use pacer api list --json');
    if (flags['--params'] !== undefined && flags['--params-file'] !== undefined) throw new ApiError('invalid_input', 'Use only one parameter source');
    let params: Record<string, unknown> = {};
    if (action === 'call' && (flags['--params'] !== undefined || flags['--params-file'] !== undefined)) {
      const text = flags['--params'] as string | undefined ?? await (deps.read ?? readParams)(flags['--params-file'] as string);
      if (Buffer.byteLength(text) > MAX_PARAMS_BYTES) throw new ApiError('too_large', 'Parameters exceed 256 KiB');
      let value: unknown;
      try { value = JSON.parse(text); } catch { throw new ApiError('invalid_input', 'Parameters must be valid JSON'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('invalid_input', 'Parameters must be a JSON object');
      params = value as Record<string, unknown>;
      sensitive = secrets(params);
    }
    if (action === 'call') assertCallerCanInvoke(ctx, name!, params);
    client = await (deps.connect ?? (() => connectClient(ctx, { protocol: 3, allowFallback: !ctx.env.PACER_PORT })))();
    const hello = await client.hello();
    const op = action === 'call' ? name! : `api.${action}`;
    if (!hello.protocol.startsWith('3.') || !hello.ops.includes(op)) throw new ApiError('unknown_op', 'The selected service does not support this operation', 'Use pacer api list --json; upgrade the service if discovery is unavailable.');
    const result = await client.call(op, action === 'describe' ? { name } : action === 'list' ? {
      ...(flags['--prefix'] !== undefined ? { prefix: flags['--prefix'] } : {}),
      ...(flags['--search'] !== undefined ? { search: flags['--search'] } : {}),
    } : params);
    let out = JSON.stringify({ result });
    if (!json && action === 'list') out = (result as { ops: {name: string; description: string}[] }).ops.map(op => `${op.name}\t${op.description}`).join('\n');
    else if (!json) out = JSON.stringify(result, null, 2);
    return { code: 0, out, err: '' };
  } catch (error) {
    const known = error instanceof ApiError;
    const code = known ? error.code : 'internal';
    const redact = (text: string) => sensitive.reduce((safe, secret) => safe.split(secret).join('[redacted]'), text);
    const body = { code, message: redact(known ? error.message : 'Service request failed'), ...(known && error.hint ? { hint: redact(error.hint) } : {}) };
    return { code: ['invalid_input', 'too_large', 'unknown_op'].includes(code) ? 2 : 1, out: '', err: json ? JSON.stringify({ error: body }) : `pacer api: ${body.message}${body.hint ? `\n${body.hint}` : ''}` };
  } finally { client?.close(); }
}
