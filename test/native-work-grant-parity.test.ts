import { expect, test } from "bun:test";
import { join } from "node:path";
import { createTask, updateTask } from "../src/tasks/store";
import { issueWorkGrant, registerWork } from "../src/dispatch/work";
import { closedPort, fakeCtx, pinnedPort } from "./helpers";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const OPS =
  "msg.inbox,msg.confirm,dispatch.tree,dispatch.wait,project.strategy.list,project.messaging.get,task.get";

const rawLines = new WeakMap<object, string[]>();
/** `native` lists the request indexes the front door must answer itself; `null` means all of them. */
async function exchange(
  home: string,
  requests: string[],
  forward: boolean,
  extra: Record<string, string> = {},
  native: number[] | null = null,
) {
  const child = Bun.spawn([front!, "api", "--stdio"], {
    cwd: home,
    env: pinnedPort({
      HOME: home,
      PACER_HOME: join(home, ".pacer"),
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      PACER_CORE_ARGV: core,
      PACER_NO_UPDATE_CHECK: "1",
      PACER_NO_SELF_REPAIR: "1",
      PACER_DISCOVERY: "off",
      PACER_DEBUG_NATIVE: "1",
      ...extra,
      ...(forward ? { PACER_FORWARD_OPS: OPS } : {}),
    }),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    await child.stdin.write(
      [JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }), ...requests].join(
        "\n",
      ) + "\n",
    );
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    const lines = stdout.trim().split("\n");
    const replies = lines.map((line) => JSON.parse(line));
    expect(replies[0]?.result?.protocol).toBe("3.0.0");
    const ops = new Set(requests.map((request) => JSON.parse(request).method as string));
    const markers = stderr.split("\n").filter((line) => {
      const match = /^native (\S+) \d+$/.exec(line);
      return match != null && ops.has(match[1]!);
    });
    // Grant callers are refused natively for ops outside WORK_GRANT_OPS even when
    // PACER_FORWARD_OPS empties the registry; pass those indexes in `native`.
    const expected = (
      forward
        ? (native ?? []).map((index) => ({ request: requests[index]!, index }))
        : requests
            .map((request, index) => ({ request, index }))
            .filter(({ index }) => native === null || native.includes(index))
    ).map(
      ({ request, index }) => `native ${JSON.parse(request).method} ${index + 2}`,
    );
    expect(markers).toEqual(expected);
    const result = replies.slice(1).sort((a, b) => a.id - b.id);
    rawLines.set(
      result,
      lines.slice(1).sort((a, b) => JSON.parse(a).id - JSON.parse(b).id),
    );
    return result;
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await child.exited;
    }
  }
}
/** Wire bytes with clock-derived fields masked (same as native-dispatch-reads-parity). */
const wire = (replies: object) =>
  rawLines.get(replies)!.map((line) =>
    line.replace(/"(waitAsOf|capturedAt)":\d{10}(\.\d+)?/g, '"$1":"<now>"'),
  );
const request = (id: number, method: string, params: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

async function seedGrant() {
  // Wall-clock now: the front door authorizes with Date.now(), so a fixture clock
  // in the past would make every issued grant look expired.
  const ctx = fakeCtx({ now: Date.now() / 1000 });
  const repo = ctx.home;
  const root = createTask(ctx, {
    brief: { goal: "root", repo },
    kind: "feature",
    requestedExecutor: null,
    timeoutS: 600,
  });
  registerWork(ctx, root.id, { allowDelegation: true });
  updateTask(ctx, root.id, (t) => {
    t.state = "running";
  });
  const child = createTask(ctx, {
    brief: { goal: "child", repo },
    kind: "debug",
    requestedExecutor: null,
    timeoutS: 60,
  });
  registerWork(ctx, child.id, {}, root.id);
  updateTask(ctx, child.id, (t) => {
    t.state = "running";
  });
  const token = issueWorkGrant(ctx, root.id, 1);
  return { home: ctx.home, token, child: child.id, root: root.id };
}

test.skipIf(!front)(
  "work-grant callers are answered natively with TypeScript's replies",
  async () => {
    const { home, token, child } = await seedGrant();
    const requests = [
      request(2, "msg.inbox", {}),
      request(3, "dispatch.tree", { id: child }),
      request(4, "dispatch.wait", { id: "not-in-tree" }),
      request(5, "project.strategy.list", {}),
      request(6, "msg.confirm", { id: "m-1" }),
      request(7, "task.get", { id: child }),
    ];
    const env = { PACER_WORK_GRANT: token, PACER_ROLE: "executor", PACER_TASK_ID: child };
    // Indexes 3–4 are outside WORK_GRANT_OPS; the front door refuses them natively
    // even under PACER_FORWARD_OPS (defense-in-depth before Core).
    const native = await exchange(home, requests, false, env);
    const forwarded = await exchange(home, requests, true, env, [3, 4]);
    expect(wire(native)).toEqual(wire(forwarded));
    expect(native[3].error.data.code).toBe("not_allowed");
  },
  60000,
);

test.skipIf(!front)(
  "unknown assistant grants are refused natively with TypeScript's replies",
  async () => {
    const ctx = fakeCtx();
    closedPort();
    const pag = `pag_${"c".repeat(64)}`;
    const requests = [
      request(2, "dispatch.tree", { id: "t-20990101-000000-abcd" }),
      request(3, "msg.inbox", {}),
      request(4, "project.messaging.get", { repo: "r" }),
    ];
    const env = { PACER_ASSISTANT_GRANT: pag };
    const native = await exchange(ctx.home, requests, false, env);
    const forwarded = await exchange(ctx.home, requests, true, env);
    expect(wire(native)).toEqual(wire(forwarded));
    expect(native.every((reply) => reply.error?.message === "Expired or revoked assistant grant")).toBe(
      true,
    );
  },
  60000,
);
