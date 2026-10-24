import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connectClient } from '../api/client';
import { ApiError } from '../api/client-types';
import { DEFAULT_PORT } from '../serve/constants';
import type { Ctx } from '../types';

export interface ServiceEndpoint { base: string; token: string }
export async function serviceEndpoint(ctx: Ctx): Promise<ServiceEndpoint> {
  const client = await connectClient(ctx, { protocol: 3, allowFallback: false });
  try {
    if (client.kind !== 'http' || !(await client.hello()).protocol.startsWith('3.')) throw new ApiError('not_allowed', 'A running protocol v3 service is required');
    const token = (await readFile(join(ctx.pacerHome, 'token'), 'utf8')).trim();
    return { base: `http://127.0.0.1:${ctx.env.PACER_PORT ?? DEFAULT_PORT}`, token };
  } finally { client.close(); }
}
