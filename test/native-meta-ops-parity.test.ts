import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callOp, opJsonSchemas } from "../src/api/ops";
import { fakeCtx } from "./helpers";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);

async function exchange(home: string, method: string, params: unknown, forward?: string) {
  const request = JSON.stringify({ jsonrpc: "2.0", id: 2, method, params });
  const child = Bun.spawn([front!, "api", "--stdio"], {
    env: {
      HOME: home,
      PACER_HOME: join(home, ".pacer"),
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      PACER_CORE_ARGV: core,
      PACER_NO_UPDATE_CHECK: "1",
      PACER_NO_SELF_REPAIR: "1",
      PACER_DISCOVERY: "off",
      PACER_DEBUG_NATIVE: "1",
      ...(forward ? { PACER_FORWARD_OPS: forward } : {}),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    await child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }) +
        "\n" +
        request +
        "\n",
    );
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    const replies = stdout.trim().split("\n").map(line => JSON.parse(line));
    const markers = stderr.split("\n").filter(line => new RegExp(`^native ${method.replace(".", "\\.")} 2$`).test(line));
    expect(markers).toEqual(forward ? [] : [`native ${method} 2`]);
    return replies[1];
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await child.exited;
    }
  }
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      out[key] = normalize(entry);
    }
    return out;
  }
  return value;
}

test("native version.get, api.list and api.describe match TypeScript", async () => {
  if (!front) return;
  const ctx = fakeCtx();
  const home = mkdtempSync(join(tmpdir(), "pacer-meta-ops-"));
  try {
    for (const [method, params] of [
      ["version.get", {}],
      ["api.list", {}],
      ["api.list", { prefix: "runner.", search: "SETTINGS" }],
      ["api.describe", { name: "runner.settings.save" }],
    ] as const) {
      const reference = await callOp(ctx, method, params);
      const reply = await exchange(home, method, params);
      expect(reply.error).toBeUndefined();
      expect(normalize(reply.result)).toEqual(normalize(reference));
    }
    const describe = await callOp(ctx, "api.describe", { name: "runner.settings.save" }) as { params: unknown };
    expect(describe.params).toEqual(opJsonSchemas()["runner.settings.save"].params);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
