/** Migration preparation only: equal forwarded responses do not prove native parity. */
import { cpSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

export interface Step { op: string; params?: unknown; expect?: "ok" | "error" }
export interface ParityOptions {
  fixture: string;
  reference: string[];
  candidate: string[];
  steps: Step[];
  native?: string[];
  timeoutMs?: number;
}
// Deliberately retain IDs, timestamps, errors and paths. Future ports must supply
// explicit relational mappings if generated values differ; erasing fields hides bugs.
export function defaultNormalize(value: unknown): unknown { return value; }

type Reply = { jsonrpc: "2.0"; id: number; result?: unknown; error?: unknown };
class Session {
  private child;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = "";
  private decoder = new TextDecoder();
  private nextId = 0;
  constructor(command: string[], home: string) {
    // Do not inherit provider tokens, host sockets, or the user's native homes.
    this.child = Bun.spawn(command, {
      env: { HOME: home, PACER_HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", TZ: "Asia/Ho_Chi_Minh", LANG: "C", PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1" },
      stdin: "pipe", stdout: "pipe", stderr: "ignore",
    });
    this.reader = this.child.stdout.getReader();
  }
  async request(step: Step, timeoutMs: number): Promise<Reply> {
    const id = ++this.nextId;
    await this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: step.op, params: step.params ?? {} }) + "\n");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.reply(id),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`${step.op} timed out`)), timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  private async reply(id: number): Promise<Reply> {
    while (!this.buffer.includes("\n")) {
      const chunk = await this.reader.read();
      if (chunk.done) throw Error("stdio closed before response");
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
      if (this.buffer.length > 1024 * 1024) throw Error("stdio response exceeds limit");
    }
    const end = this.buffer.indexOf("\n");
    const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
    let value: any;
    try { value = JSON.parse(line); } catch { throw Error("malformed JSON-RPC response"); }
    if (!value || value.jsonrpc !== "2.0" || value.id !== id ||
        Object.hasOwn(value, "result") === Object.hasOwn(value, "error")) throw Error("malformed JSON-RPC response or unexpected id");
    return value;
  }
  async finish(timeoutMs: number) {
    await this.child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([
        this.child.exited,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("stdio shutdown timed out")), timeoutMs); }),
      ]);
      if (code !== 0) throw Error(`stdio exited with status ${code}`);
      while (true) {
        const chunk = await this.reader.read();
        if (chunk.done) break;
        this.buffer += this.decoder.decode(chunk.value, { stream: true });
        if (this.buffer.length > 1024 * 1024) throw Error("stdio response exceeds limit");
      }
      if (this.buffer.trim()) throw Error("unexpected trailing stdio output");
    } finally { clearTimeout(timer); }
  }
  async close() {
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
    await this.child.exited;
    await this.reader.cancel();
  }
}

function tree(root: string, relative = ""): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (const name of readdirSync(join(root, relative)).sort()) {
    const path = join(relative, name), absolute = join(root, path), stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) entries[path] = { link: readlinkSync(absolute) };
    else if (stat.isDirectory()) { entries[path] = { directory: true, mode: stat.mode & 0o777 }; Object.assign(entries, tree(root, path)); }
    else if (stat.isFile()) {
      const bytes = readFileSync(absolute);
      const content = name.endsWith(".json") ? JSON.parse(bytes.toString()) : name.endsWith(".jsonl") ? bytes.toString().split("\n").filter(Boolean).map(line => JSON.parse(line)) : bytes.toString("base64");
      entries[path] = { mode: stat.mode & 0o777, content };
    } else throw Error(`unsupported fixture entry ${path}`);
  }
  return entries;
}
function compare(kind: string, reference: unknown, candidate: unknown) {
  if (!isDeepStrictEqual(reference, candidate)) throw Error(`${kind} mismatch\n- reference ${JSON.stringify(reference)}\n+ candidate ${JSON.stringify(candidate)}`);
}
export async function parity(options: ParityOptions): Promise<void> {
  if (options.native?.length) throw Error(`native execution evidence unavailable for ${options.native.join(", ")}; migration parity is UNVERIFIED`);
  const temporary = mkdtempSync(join(tmpdir(), "pacer-parity-"));
  const homes = [join(temporary, "ts"), join(temporary, "rs")];
  const sessions: Session[] = [];
  try {
    for (const home of homes) cpSync(options.fixture, home, { recursive: true, errorOnExist: true });
    sessions.push(new Session(options.reference, homes[0]!));
    sessions.push(new Session(options.candidate, homes[1]!));
    for (const step of [{ op: "hello", params: { protocol: 3 } }, ...options.steps]) {
      const replies = await Promise.all(sessions.map(session => session.request(step, options.timeoutMs ?? 5000)));
      for (const reply of replies) {
        if (step.expect === "ok" && Object.hasOwn(reply, "error")) throw Error(`${step.op}: expected success`);
        if (step.expect === "error" && !Object.hasOwn(reply, "error")) throw Error(`${step.op}: expected error`);
      }
      compare("response", replies[0], replies[1]);
    }
    await Promise.all(sessions.map(session => session.finish(options.timeoutMs ?? 5000)));
    compare("filesystem", tree(homes[0]!), tree(homes[1]!));
  } finally {
    for (const session of sessions) await session.close();
    rmSync(temporary, { recursive: true, force: true });
  }
}
