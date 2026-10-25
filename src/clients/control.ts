import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { CoreError } from '../core/errors';

export const clientAction = z.discriminatedUnion('type', [
  z.object({type: z.literal('theme.get')}),
  z.object({type: z.literal('theme.set'), value: z.enum(['system', 'light', 'dark'])}),
  z.object({type: z.literal('navigate'), route: z.string().min(1).max(2048).regex(/^\/(?!\/)[^\u0000-\u001f]*$/)}),
  z.object({type: z.literal('window'), action: z.enum(['show', 'minimize', 'toggle-maximize', 'close'])}),
  z.object({type: z.literal('tray'), action: z.enum(['show', 'hide'])}),
  z.object({type: z.literal('launch-at-login'), enabled: z.boolean()}),
  z.object({type: z.literal('quit')}),
]);
export type ClientAction = z.infer<typeof clientAction>;
interface Worker { client_id: string; kind: 'app' | 'desktop'; window: 'main' | 'tray'; token: string; expires: number }
interface Request { request_id: string; client_id: string; action: ClientAction; status: 'pending' | 'claimed' | 'complete' | 'failed'; deadline: number; result?: unknown; error?: string }

/** Bounded transient requests; workers acknowledge after applying an allowlisted action. */
export class ClientControl {
  private workers = new Map<string, Worker>();
  private requests = new Map<string, Request>();
  constructor(private now = Date.now) {}
  private prune() {
    const now = this.now();
    for (const [id, worker] of this.workers) if (worker.expires < now) this.workers.delete(id);
    for (const [id, request] of this.requests) {
      if (request.deadline + 60000 < now) this.requests.delete(id);
      else if (request.deadline < now && ['pending', 'claimed'].includes(request.status)) { request.status = 'failed'; request.error = 'client_timeout'; }
    }
  }
  enroll(kind: Worker['kind'], window: Worker['window']) {
    this.prune();
    if (this.workers.size >= 64) throw new CoreError('conflict', 'Too many client control workers');
    const client_id = randomUUID(), token = randomBytes(32).toString('hex');
    this.workers.set(client_id, {client_id, kind, window, token, expires: this.now() + 60000});
    return {client_id, worker_token: token};
  }
  private authorize(client_id: string, token: string) {
    this.prune();
    const worker = this.workers.get(client_id);
    if (!worker || token.length !== worker.token.length || !timingSafeEqual(Buffer.from(token), Buffer.from(worker.token))) throw new CoreError('not_allowed', 'Client control credential rejected');
    worker.expires = this.now() + 60000;
    return worker;
  }
  targets() {
    this.prune();
    return [...this.workers.values()].map(({token: _, expires: __, ...worker}) => worker);
  }
  request(client_id: string, action: ClientAction) {
    this.prune();
    const worker = this.workers.get(client_id);
    if (!worker) throw new CoreError('not_found', 'Client is unavailable', 'Use client.control.targets to choose a connected client.');
    if (worker.window === 'tray' && action.type === 'navigate') throw new CoreError('not_allowed', 'Navigation requires a main page target', 'Select a main target to preserve unsaved-form confirmation; use pacer open to launch a screen.');
    const parsed = clientAction.safeParse(action);
    if (!parsed.success) throw new CoreError('invalid_input', 'Unsupported client action');
    if (worker.kind !== 'desktop' && ['window', 'tray', 'quit', 'launch-at-login'].includes(action.type)) throw new CoreError('not_allowed', 'A native desktop client is required');
    if (this.requests.size >= 256 || [...this.requests.values()].some(r => r.client_id === client_id && ['pending', 'claimed'].includes(r.status))) throw new CoreError('conflict', 'Client has an outstanding action');
    const request: Request = {request_id: randomUUID(), client_id, action: parsed.data, status: 'pending', deadline: this.now() + 30000};
    this.requests.set(request.request_id, request); return {...request};
  }
  claim(client_id: string, token: string) {
    this.authorize(client_id, token);
    const request = [...this.requests.values()].find(r => r.client_id === client_id && r.status === 'pending');
    if (!request) return null;
    request.status = 'claimed'; return {...request};
  }
  complete(id: string, token: string, result?: unknown, error?: string) {
    const request = this.get(id); this.authorize(request.client_id, token);
    if (request.status !== 'claimed') throw new CoreError('conflict', 'Client request is not awaiting acknowledgment');
    request.status = error ? 'failed' : 'complete';
    if (error) request.error = error; else request.result = result;
    return {...request};
  }
  private get(id: string) {
    this.prune(); const request = this.requests.get(id);
    if (!request) throw new CoreError('not_found', 'Client action expired or does not exist');
    return request;
  }
  result(id: string) { return {...this.get(id)}; }
}
const brokers = new Map<string, ClientControl>();
export function clientControl(home: string): ClientControl {
  let broker = brokers.get(home);
  if (!broker) { broker = new ClientControl(); brokers.set(home, broker); }
  return broker;
}
