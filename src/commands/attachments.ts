import { open, unlink } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { ApiError, type ApiErrorCode } from '../api/client-types';
import { serviceEndpoint, type ServiceEndpoint } from './service-endpoint';
import type { Command, Result } from './types';
import type { Ctx } from '../types';
const MAX_FILE = 25 * 1024 * 1024;
export const ATTACHMENT_USAGE = 'attachment list|upload|remove|download --draft <id> [--file <path>] [--id <id>] [--out <path>] [--json]';

export async function attachmentCommand(args: string[], ctx: Ctx, deps: {
  endpoint?: () => Promise<ServiceEndpoint>;
  fetch?: (request: Request) => Promise<Response>;
} = {}): Promise<Result> {
  let created: string | undefined;
  try {
    const [action, ...rest] = args;
    if (!['list', 'upload', 'remove', 'download'].includes(action)) throw new ApiError('invalid_input', ATTACHMENT_USAGE);
    const flags: Record<string, string | true> = {};
    const allowed = ['--draft', '--json', ...(action === 'upload' ? ['--file'] : action === 'list' ? [] : ['--id']), ...(action === 'download' ? ['--out'] : [])];
    for (let i = 0; i < rest.length; i++) {
      const name = rest[i];
      if (!allowed.includes(name) || Object.hasOwn(flags, name)) throw new ApiError('invalid_input', 'Unknown or repeated argument');
      if (name === '--json') flags[name] = true;
      else { const value = rest[++i]; if (!value || value.startsWith('--')) throw new ApiError('invalid_input', 'Argument requires a value'); flags[name] = value; }
    }
    const draft = flags['--draft'], id = flags['--id'];
    if (typeof draft !== 'string' || !/^[\w-]{1,128}$/.test(draft) || (['remove', 'download'].includes(action) && (typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id)))) throw new ApiError('invalid_input', 'A valid --draft and attachment --id are required');
    if (action === 'upload' && typeof flags['--file'] !== 'string') throw new ApiError('invalid_input', 'upload requires --file');
    if (action === 'download' && typeof flags['--out'] !== 'string') throw new ApiError('invalid_input', 'download requires --out; existing files are never replaced');
    const endpoint = await (deps.endpoint ?? (() => serviceEndpoint(ctx)))();
    const url = new URL(`/v3/attachments${id ? `/${id}` : ''}`, endpoint.base);
    url.searchParams.set('draft', draft);
    const headers = new Headers({ Authorization: `Bearer ${endpoint.token}` });
    let body: Blob | undefined;
    if (action === 'upload') {
      const file = Bun.file(resolve(flags['--file'] as string));
      if (!await file.exists()) throw new ApiError('invalid_input', 'Attachment file does not exist');
      if (file.size > MAX_FILE) throw new ApiError('too_large', 'Attachment exceeds 25 MiB');
      headers.set('X-Pacer-Filename', encodeURIComponent(basename(flags['--file'] as string)));
      headers.set('Content-Type', file.type || 'application/octet-stream');
      url.searchParams.set('batch', crypto.randomUUID()); body = file;
    }
    const response = await (deps.fetch ?? fetch)(new Request(url, { method: action === 'upload' ? 'POST' : action === 'remove' ? 'DELETE' : 'GET', headers, body, signal: AbortSignal.timeout(60000), redirect: 'error' }));
    if (!response.ok) {
      const value = await response.json().catch(() => ({})) as { error?: {code: ApiErrorCode; message: string; hint?: string} };
      throw new ApiError(value.error?.code ?? 'internal', value.error?.message ?? 'Attachment request failed', value.error?.hint);
    }
    let result: unknown = { removed: true };
    if (action === 'download') {
      const path = resolve(flags['--out'] as string);
      const file = await open(path, 'wx', 0o600).catch(() => { throw new ApiError('invalid_input', 'Cannot create output file; it may already exist'); });
      created = path;
      try {
        let size = 0;
        if (response.body) for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > MAX_FILE) throw new ApiError('too_large', 'Attachment exceeds 25 MiB');
          await file.writeFile(chunk);
        }
        result = { path, size };
      } finally { await file.close(); }
      created = undefined;
    } else if (action !== 'remove') result = await response.json();
    return { code: 0, out: args.includes('--json') ? JSON.stringify({ result }) : JSON.stringify(result, null, 2), err: '' };
  } catch (error) {
    if (created) await unlink(created).catch(() => {});
    const value = error instanceof ApiError ? { code: error.code, message: error.message, ...(error.hint ? {hint: error.hint} : {}) } : {code: 'internal', message: 'Attachment request failed'};
    return { code: value.code === 'invalid_input' || value.code === 'too_large' ? 2 : 1, out: '', err: args.includes('--json') ? JSON.stringify({error: value}) : value.message };
  }
}
export const COMMANDS: Command[] = [{ name: 'attachment', usage: ATTACHMENT_USAGE, run: attachmentCommand }];
