import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdinLines } from "../packages/plugin-sdk/src";

test("actual SDK stdio preserves a split UTF8 scalar and inline BOM in capability replies", async () => {
  const root = mkdtempSync(join(tmpdir(), "pacer-sdk-utf8-"));
  const sdk = new URL("../packages/plugin-sdk/src/index.ts", import.meta.url).href;
  const script = `import {serve} from ${JSON.stringify(sdk)};
await serve({manifest:{id:"utf8-fixture",version:"0.2.0",publisher:"fixture",host:"^1.1",contributes:{diagnostic:{}}},
  handlers:{"fixture.echo":async(_params,host)=>host.call("capability.fs.read",{path:"/public-fixture"})}});`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { HOME: root, PACER_HOME: root },
  });
  const reader = child.stdout.getReader(), decoder = new TextDecoder();
  const stderr = new Response(child.stderr).text();
  let buffer = "";
  async function readFrame(): Promise<any> {
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        return JSON.parse(line);
      }
      const next = await reader.read();
      if (next.done) throw Error("SDK fixture stdout ended before its reply");
      buffer += decoder.decode(next.value, { stream: true });
    }
  }
  async function next(): Promise<any> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([readFrame(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("SDK fixture frame timeout")), 2000);
      })]);
    } finally { clearTimeout(timer); }
  }
  const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
  try {
    send({ jsonrpc: "2.0", id: 1, method: "plugin.hello", params: {
      protocol: "1.1.0", pacer: "fixture", manifest: {}, features: [], config: {}, grants: [],
    } });
    expect((await next()).id).toBe(1);
    send({ jsonrpc: "2.0", id: 2, method: "fixture.echo", params: {}, _meta: { capabilityCall: "private-fixture-token" } });
    const request = await next();
    expect(request.method).toBe("capability.fs.read");
    const expected = "\ufeff界";
    const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { text: expected, mtime: 0 } }) + "\n");
    const start = bytes.indexOf(Buffer.from("界"));
    child.stdin.write(bytes.subarray(0, start + 1));
    await Bun.sleep(30);
    child.stdin.write(bytes.subarray(start + 1));
    const reply = await next();
    expect(reply.id).toBe(2);
    expect(reply.result).toEqual({ text: expected, mtime: 0 });
    child.stdin.end();
    expect(await child.exited).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    await reader.cancel().catch(() => {}); reader.releaseLock();
    const errors = await stderr;
    rmSync(root, { recursive: true, force: true });
    expect(errors).toBe("");
  }
});

test("stdin lines retain the original initial BOM rather than silently normalizing JSON", async () => {
  const bytes = Buffer.from('\ufeff{"public":"界"}\n');
  async function* fragments() {
    yield bytes.subarray(0, 1);
    yield bytes.subarray(1, 2);
    yield bytes.subarray(2);
  }
  const lines: string[] = [];
  for await (const line of stdinLines(fragments())) lines.push(line);
  expect(lines).toEqual(['\ufeff{"public":"界"}']);
});

test("stdin EOF flush retains the replacement character for an incomplete final scalar", async () => {
  async function* fragments() {
    yield Buffer.from("first\nlast ");
    yield Buffer.from([0xe7, 0x95]);
  }
  const lines: string[] = [];
  for await (const line of stdinLines(fragments())) lines.push(line);
  expect(lines).toEqual(["first", "last \ufffd"]);
});
