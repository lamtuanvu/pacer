import { afterAll, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HostError, type HostClient } from "../conformance/host";
import { type FrontDoor } from "../conformance/run";
import { front, freePort } from "./native-plugin-door";

export const tsHost = [process.execPath, join(import.meta.dir, "..", "src", "cli.ts")];
export const ownerEnv = {
  PACER_CORE_ARGV: JSON.stringify(tsHost), PACER_NATIVE_PLUGIN_HOST: "1", PACER_FORWARD_OPS: "",
  PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1",
};

/** A conformance client over a flag-on `pacer serve`: ops are HTTP posts, errors keep their code. */
export class ServeSession implements HostClient {
  readonly events: { type: string; data: unknown }[] = [];
  readonly stderr: string[] = [];
  private child?: Bun.Subprocess<"ignore", "ignore", "pipe">;
  private base = "";
  private token = "";
  constructor(private readonly argv: string[], private readonly env: Record<string, string>) {}

  get pid() { return this.child?.pid; }

  /** Public event subscription is not part of this subset; `subscribe` is accepted and ignored. */
  async start(): Promise<this> {
    const port = freePort();
    const child = this.child = Bun.spawn([...this.argv, "serve", "--port", String(port)], { env: { ...this.env, PACER_PORT: String(port) }, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    void (async () => { const decoder = new TextDecoder(); for await (const chunk of child.stderr) this.stderr.push(decoder.decode(chunk, { stream: true })); })();
    this.base = `http://127.0.0.1:${port}`;
    for (let i = 0; ; i++) {
      try {
        this.token = readFileSync(join(this.env.PACER_HOME!, "token"), "utf8").trim();
        if ((await fetch(`${this.base}/v3/hello`, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(500) })).ok) break;
      } catch { /* Wait for this serve only. */ }
      if (child.exitCode !== null || i > 750) { child.kill("SIGKILL"); throw Error(`serve did not start:\n${this.stderr.join("")}`); }
      await Bun.sleep(20);
    }
    if (!existsSync(join(this.env.PACER_HOME!, "run", "host.sock"))) throw Error("flag-on serve did not bind run/host.sock");
    return this;
  }

  async call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    // Serve's handshake is `GET /v3/hello`, not an operation.
    if (method === "hello") {
      const response = await fetch(`${this.base}/v3/hello`, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new HostError("internal", `hello answered ${response.status}`);
      return await response.json() as T;
    }
    const response = await fetch(`${this.base}/v3/ops/${method}`, { method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" }, body: JSON.stringify(params), signal: AbortSignal.timeout(30000) });
    const body = await response.json() as { result?: T; error?: { code?: string; message: string } };
    if (body.error) throw new HostError(body.error.code ?? "internal", body.error.message);
    return body.result as T;
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    if (await Promise.race([child.exited, Bun.sleep(20000).then(() => "hung")]) === "hung") child.kill("SIGKILL");
    await child.exited;
  }
}

export type Door = { label: string; argv: string[]; door: FrontDoor };
export const doors: Door[] = front ? [
  { label: "stdio owner", argv: [front], door: { env: ownerEnv, homePrefix: "s-" } },
  { label: "serve owner", argv: [front], door: { env: ownerEnv, homePrefix: "h-", session: (argv, env) => new ServeSession(argv, env) } },
] : [];
export const tsDoor: Door = { label: "typescript", argv: tsHost, door: { homePrefix: "t-" } };

/** Owner sockets bind under the home, so every home sits directly in a short /tmp root of this file's own. */
export function conformanceRoot() {
  const root = mkdtempSync("/tmp/pcn-");
  // A flag-on serve's Core can still be writing its home for a moment after serve exits.
  afterAll(async () => { await Bun.sleep(1000); rmSync(root, { recursive: true, force: true }); });
  return root;
}

export const listed = async (h: HostClient) => (await h.call<{ plugins: { id: string; state: string; pid: number | null }[] }>("plugin.list")).plugins;
export const doctor = async (h: HostClient, id: string) => (await h.call<{ reports: { ok: boolean; pid: number | null; error: string | null }[] }>("plugin.doctor", { id })).reports[0]!;

export const cases = (reason: string | null) => !front ? test.skip : reason ? test.failing : test;

export const coreDoctor: Door[] = front ? [{ label: "serve owner, Core doctor", argv: [front],
  door: { env: { ...ownerEnv, PACER_FORWARD_OPS: "plugin.doctor" }, homePrefix: "c-", session: (argv, env) => new ServeSession(argv, env) } }] : [];
