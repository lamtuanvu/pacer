import type { SessionSocket } from '../term/client';
import type { ConnectionStatus } from './types';

export interface IpcChannel { onmessage: (message: IpcMessage) => void }
export interface IpcCore {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  Channel?: new () => IpcChannel;
}
export interface IpcMessage { type: string; event?: string; data?: string; id?: number; bytes?: number[]; status?: ConnectionStatus; reason?: string; warning?: string; attempt?: number; nextRetry?: number; frame?: IpcMessage; size?: number }
interface Reply { status: number; body: number[]; contentType?: string }
export interface DesktopConnection { status: ConnectionStatus; reason?: string; warning?: string; attempt?: number; nextRetry?: number }
/** EventSource-shaped boundary keeps protocol reducers shared with the browser. */
class Source {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  closed = false;
  cursor = 0;
  lastDelivery = 0;
  constructor(private dispose: () => void = () => {}) {}
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) { if (listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(listener); } }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) { if (listener) this.listeners.get(type)?.delete(listener); }
  emit(type: string, message?: IpcMessage) {
    if (this.closed) return;
    const event = message ? new MessageEvent(type, { data: message.data ?? '', lastEventId: String(message.id ?? 0) }) : new Event(type);
    if (type === 'open') this.onopen?.(event);
    if (type === 'error') this.onerror?.(event);
    for (const listener of this.listeners.get(type) ?? []) typeof listener === 'function' ? listener(event) : listener.handleEvent(event);
  }
  close() { if (!this.closed) { this.closed = true; this.dispose(); this.listeners.clear(); } }
}
export function createIpcTransport(core: IpcCore | undefined) {
  const invoke = core?.invoke;
  const Channel = core?.Channel;
  const instance = crypto.randomUUID();
  const call = (command: string, args: Record<string, unknown> = {}) => {
    if (!invoke) return Promise.reject(Error('Desktop IPC unavailable'));
    return invoke(command, { instance, ...args });
  };
  const channel = () => { if (!Channel) throw Error('Desktop Channels unavailable'); return new Channel(); };
  let connection: DesktopConnection = { status: 'connecting' };
  const listeners = new Set<(status: ConnectionStatus) => void>();
  const detailListeners = new Set<(state: DesktopConnection) => void>();
  const sources = new Set<Source>();
  let events: IpcChannel | undefined;
  const backlog: IpcMessage[] = [];
  let backlogBytes = 0, droppedBefore = 0, delivery = 0;
  let lastResync: IpcMessage | undefined;
  let snapshotDelivery = 0;
  const positions = new WeakMap<IpcMessage,number>();
  function deliver(source: Source, message: IpcMessage) {
    const position=positions.get(message);
    // A completed snapshot has already handled resets known when its read began.
    // Keep resets arriving during that read: its response may predate them.
    if (message.type === 'resync' && position !== undefined && position <= snapshotDelivery) return;
    if (position !== undefined) { if (position<=source.lastDelivery) return; source.lastDelivery=position; }
    if (message.type !== 'resync' && message.id !== undefined && message.id <= source.cursor) return;
    if (message.id !== undefined) source.cursor = message.id;
    source.emit(message.type === 'resync' ? 'reset' : message.event ?? 'message', message);
  }
  function update(next: DesktopConnection) {
    connection = next;
    for (const listener of listeners) listener(next.status);
    for (const listener of detailListeners) listener(next);
  }
  function startEvents() {
    if (events) return;
    events = channel();
    events.onmessage = message => {
      if (message.type === 'status') {
        update({status:message.status ?? 'connecting',reason:message.reason,warning:message.warning,attempt:message.attempt,nextRetry:message.nextRetry});
        for (const source of sources) source.emit(message.status === 'connected' ? 'open' : 'error');
      } else {
        positions.set(message,++delivery);
        if (message.type === 'resync') { lastResync=message; backlog.length=0; backlogBytes=0; droppedBefore=0; }
        backlog.push(message); backlogBytes+=(message.data?.length ?? 0)+64;
        while (backlogBytes>1024*1024 && backlog.length) {
          const dropped=backlog.shift()!;backlogBytes-=(dropped.data?.length ?? 0)+64; droppedBefore=dropped.id ?? droppedBefore;
        }
        for (const source of sources) deliver(source,message);
      }
    };
    void call('service_events', {channel:events}).catch(() => update({status:'reconnecting'}));
  }
  function stream(command: string, args: Record<string, unknown>, signal?: AbortSignal | null) {
    const pipe = channel(), streamId = crypto.randomUUID();
    let finished = false;
    let pending: Promise<unknown> | undefined;
    const stop = () => { if (!finished) { finished = true; void Promise.resolve(pending).then(()=>call('stream_cancel',{streamId})).catch(() => {}); } };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        pipe.onmessage = message => {
          if (finished) return;
          if (message.type === 'chunk') {
            const bytes=new Uint8Array(message.bytes ?? []);
            if (bytes.byteLength>(controller.desiredSize ?? 0)) { stop(); controller.error(Error('Stream output queue is full')); return; }
            controller.enqueue(bytes);
          }
          else if (message.type === 'resync') { stop(); controller.error(Error('Stream requires resync')); }
          else if (message.type === 'end') { finished = true; controller.close(); }
          else if (message.type === 'error') { finished = true; controller.error(Error(message.reason ?? 'Stream interrupted')); }
          if (message.size) void call('stream_ack',{streamId,size:message.size}).catch(()=>{});
        };
        signal?.addEventListener('abort', () => { stop(); controller.error(new DOMException('Aborted','AbortError')); }, {once:true});
        pending = call(command,{...args,channel:pipe,streamId}).catch(error => { if (!finished) { finished = true; controller.error(error); } });
      }, cancel: stop,
    }, {highWaterMark:1024*1024,size:chunk=>chunk?.byteLength ?? 0});
    return new Response(body,{headers:{'content-type':'text/event-stream'}});
  }
  return {
    async request(path: string, init: RequestInit = {}): Promise<Response> {
      if (!path.startsWith('/v3/')) throw Error('Unsupported desktop route');
      const url = new URL(path,'http://ipc.invalid'), headers = new Headers(init.headers);
      // One page identity covers its API clients, events and terminal sockets.
      const identity = instance;
      let command: string, args: Record<string,unknown> = {};
      const op = /^\/v3\/ops\/([a-z][a-z0-9_.]*)$/.exec(url.pathname);
      const assistant = /^\/v3\/assistant\/turns\/([^/]+)\/stream$/.exec(url.pathname);
      const attachment = /^\/v3\/attachments(?:\/([^/]+))?$/.exec(url.pathname);
      if (op && init.method === 'POST') { command='service_call'; args={op:op[1],params:JSON.parse(String(init.body ?? '{}'))}; }
      else if (url.pathname === '/v3/hello') command='service_hello';
      else if (url.pathname === '/v3/snapshot') command='service_snapshot';
      else if (assistant) return stream('assistant_turn_stream',{id:assistant[1]},init.signal);
      else if (attachment) {
        args={draft:url.searchParams.get('draft') ?? '',...(attachment[1]?{id:attachment[1]}:{})};
        command = init.method === 'POST' ? 'attachment_upload' : init.method === 'DELETE' ? 'attachment_delete' : attachment[1] ? 'attachment_read' : 'attachment_list';
        if (command === 'attachment_upload') {
          const blob = new Response(init.body).blob();
          const file = await blob;
          if (file.size > 25*1024*1024) throw Error('Attachment exceeds 25 MiB');
          Object.assign(args,{batch:url.searchParams.get('batch') ?? '',name:decodeURIComponent(headers.get('X-Pacer-Filename') ?? 'attachment'),mime:headers.get('Content-Type') ?? 'application/octet-stream',bytes:Array.from(new Uint8Array(await file.arrayBuffer()))});
        }
      } else throw Error('Unsupported desktop route');
      const beforeRequest = delivery;
      const reply = await call(command,{...args,instance:identity}) as Reply;
      if (command === 'service_snapshot' && reply.status >= 200 && reply.status < 300) {
        snapshotDelivery = Math.max(snapshotDelivery, beforeRequest);
      }
      return new Response(reply.status === 204 ? null : new Uint8Array(reply.body),{status:reply.status,headers:{'content-type':reply.contentType ?? 'application/json'}});
    },
    subscribeEvents(path: string): EventSource {
      const log = /^\/v3\/tasks\/([^/]+)\/log\?/.exec(path);
      if (log) {
        const pipe = channel(), streamId = crypto.randomUUID();
        let pending: Promise<unknown>;
        const source = new Source(() => { void Promise.resolve(pending).then(()=>call('stream_cancel',{streamId})).catch(() => {}); });
        pipe.onmessage = message => {
          if (source.closed) return;
          source.emit(message.type === 'event' ? message.event ?? 'message' : message.type === 'end' ? 'done' : message.type === 'resync' ? 'reset' : message.type, message);
          if (message.size) void call('stream_ack',{streamId,size:message.size}).catch(()=>{});
        };
        pending = call('task_log_follow',{id:log[1],from:Number(new URL(path,'http://ipc.invalid').searchParams.get('from') ?? 0),channel:pipe,streamId}).catch(() => source.emit('error'));
        return source as unknown as EventSource;
      }
      if (!/^\/v3\/events(?:\?|$)/.test(path)) throw Error('Unsupported desktop stream');
      const source = new Source(() => sources.delete(source));
      source.cursor=Number(new URL(path,'http://ipc.invalid').searchParams.get('since') ?? 0);
      sources.add(source); startEvents();
      queueMicrotask(() => {
        if (source.cursor < droppedBefore) deliver(source,{type:'resync',id:droppedBefore,data:'{}'});
        else {
          if (lastResync) deliver(source,lastResync);
          for (const message of backlog) deliver(source,message);
        }
      });
      if (connection.status === 'connected') queueMicrotask(() => source.emit('open'));
      return source as unknown as EventSource;
    },
    attachTerminal(url: string): SessionSocket {
      // The shared terminal still constructs v2 URLs for browser compatibility; IPC always uses v3.
      const path = new URL(url,'http://ipc.invalid').pathname;
      const match = /^\/v[23]\/(tasks|terminals)\/([^/]+)\/session$/.exec(path);
      if (!match) throw Error('Unsupported terminal target');
      const target = {kind:match[1] === 'tasks' ? 'task' : 'terminal',id:match[2]}, pipe = channel(), attachment = crypto.randomUUID();
      let closed = false, attaching: Promise<unknown> | undefined;
      const socket: SessionSocket = {
        readyState:0,binaryType:'arraybuffer',onopen:null,onclose:null,onerror:null,onmessage:null,
        send(data) {
          if (closed) return;
          if (typeof data !== 'string') { void send('terminal_send',{bytes:Array.from(data)}); return; }
          const frame = JSON.parse(data);
          if (frame.type === 'hello') {
            attaching = send('terminal_attach',{target,from:frame.from,hello:frame,channel:pipe});
          } else if (frame.type === 'take') void send('terminal_take',{force:frame.force === true});
          else if (frame.type === 'release') void send('terminal_release');
          else if (frame.type === 'focus') void send('terminal_focus');
          else if (frame.type === 'size') void send('terminal_resize',{cols:frame.cols,rows:frame.rows});
          else throw Error('Unsupported terminal frame');
        },
        close() { if (!closed) { closed=true; socket.readyState=3; void Promise.resolve(attaching).then(()=>call('terminal_detach',{attachment})).catch(() => {}); } },
      };
      const send = (command: string,args: Record<string,unknown> = {}) => call(command,{attachment,...args}).catch(() => { if (!closed) { socket.close(); socket.onerror?.(); socket.onclose?.(); } });
      pipe.onmessage = message => {
        if (closed) return;
        if (message.type === 'end' || message.type === 'error') { socket.close(); socket.onclose?.(); }
        else {
          const frame = message.frame ?? message;
          socket.onmessage?.({data:frame.type === 'binary' ? new Uint8Array(frame.bytes ?? []).buffer : frame.data});
          if (message.size) void call('terminal_ack',{attachment,size:message.size}).catch(() => {});
        }
      };
      queueMicrotask(() => { if (!closed) { socket.readyState=1; socket.onopen?.(); } });
      return socket;
    },
    subscribeConnection(listener: (status: ConnectionStatus) => void) { listeners.add(listener); listener(connection.status); return () => { listeners.delete(listener); }; },
    subscribeDesktopConnection(listener: (state: DesktopConnection) => void) { detailListeners.add(listener); listener(connection); startEvents(); return () => { detailListeners.delete(listener); }; },
    // Rust owns desktop status. Store status updates must not overwrite a version gate.
    setConnectionStatus(_status: ConnectionStatus) {},
  };
}
