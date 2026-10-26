import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export class HostError extends Error { constructor(public readonly code: string, message: string) { super(message); this.name = "HostError"; } }
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** A client of `<host> api --stdio`, using only the client protocol. */
export class HostSession {
  private child!: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  readonly events: { type: string; data: unknown }[] = [];
  readonly stderr: string[] = [];
  constructor(private readonly argv: string[], private readonly env: Record<string, string | undefined>) {}

  async start(options:{subscribe?:boolean}={}): Promise<this> {
    this.child = spawn(this.argv[0]!, [...this.argv.slice(1), "api", "--stdio"], { env: this.env, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => { buf += chunk; let i; while ((i = buf.indexOf("\n")) !== -1) { this.receive(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (c: string) => this.stderr.push(c));
    this.child.on("exit", () => { for (const p of this.pending.values()) p.reject(new HostError("internal", "host exited")); this.pending.clear(); });
    await this.call("hello", { protocol: 3 });
    if(options.subscribe!==false)await this.call("subscribe", { since: 0 });
    return this;
  }

  private receive(line: string): void {
    let m: Record<string, unknown>;
    try { m = JSON.parse(line); } catch { return; }
    if (m.method === "event") { const e = m.params as { type: string; data: unknown }; this.events.push(e); return; }
    if (typeof m.id !== "number") return;
    const p = this.pending.get(m.id); if (!p) return;
    this.pending.delete(m.id);
    if (m.error) { const err = m.error as { message: string; data?: { code?: string } }; p.reject(new HostError(err.data?.code ?? "internal", err.message)); }
    else p.resolve(m.result);
  }

  call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: v => resolve(v as T), reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  get pid(): number | undefined { return this.child.pid; }

  /** Close stdin and wait for the host to exit (it must stop its plugins on the way out). */
  async close(): Promise<void> {
    if (this.child.exitCode !== null) return;
    const exited = new Promise<void>(r => this.child.once("exit", () => r()));
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 10_000);
    await exited; clearTimeout(timer);
  }
}

/** Fixture-side canonical publisher: cases stay independent of host implementation/registry.
 * This writes only the existing private fixture outbox, never runs the service pump. */
export async function publishTaskFixtureEvent(home:string,id:string):Promise<void> {
  const [{publish},{taskData},{readTask},{join}]=await Promise.all([import('../src/link/publish'),import('../src/link/pump'),import('../src/tasks/store'),import('node:path')]);
  const ctx:import('../src/types').Ctx={home,pacerHome:join(home,'.pacer'),now:Date.now()/1000,env:{HOME:home,PACER_HOME:join(home,'.pacer')},which:()=>null,run:async()=>{throw Error('fixture event publisher cannot execute commands');}};
  const task=readTask(ctx,id);if(!task)throw Error('fixture task missing');
  const report=await publish(ctx,[{type:'task',data:taskData(task)}]);
  if(report.errors.length)throw Error('fixture task event publication failed');
}
