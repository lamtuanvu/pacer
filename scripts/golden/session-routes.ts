import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "../../test/helpers";
import { createTask } from "../../src/tasks/store";
import { upgradeSession, type SessionWS } from "../../src/serve/session-ws";
import { encodeHeader } from "../../src/session/framing";
export async function recordRoutes() {
  const ctx = fakeCtx(),
    task = createTask(ctx, {
      brief: { goal: "fixture", repo: ctx.home },
      kind: null,
      requestedExecutor: null,
      timeoutS: 10,
    });
  const dir = join(ctx.pacerHome, "runs", task.id, "1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "session.log"),
    encodeHeader({ cols: 80, rows: 24, startedAt: 0, generation: 0 }),
  );
  const rows = [];
  for (const raw of [
    null,
    "",
    " ",
    "\ufeff",
    "\u0085",
    "0",
    "-0",
    "+1",
    "1.0",
    "1e2",
    "0x10",
    "0b10",
    "0o10",
    "01",
    "-1",
    "0.1",
    "Infinity",
    "NaN",
    "9007199254740991",
    "9007199254740992",
    "9007199254740990.9",
    "1_0",
  ]) {
    let data: SessionWS | undefined;
    const response = await upgradeSession(
      new Request(
        "http://localhost/session" +
          (raw === null ? "" : "?from=" + encodeURIComponent(raw)),
      ),
      {
        upgrade: (_req: Request, opts: { data: SessionWS }) => {
          data = opts.data;
          return true;
        },
      } as any,
      ctx,
      task.id,
    );
    rows.push({
      raw,
      status: response?.status ?? 101,
      body: response ? await response.text() : null,
      from: data?.from === 0 ? 0 : (data?.from ?? null),
    });
  }
  const errors = [];
  for (const [method, id, upgrade] of [
    ["POST", task.id, true],
    ["GET", "unknown", true],
    ["GET", task.id, false],
  ] as const) {
    const response = await upgradeSession(
      new Request("http://localhost/session", { method }),
      { upgrade: () => upgrade } as any,
      ctx,
      id,
    );
    errors.push({
      method,
      id: id === task.id ? "<task>" : id,
      upgrade,
      status: response?.status,
      body: await response?.text(),
    });
  }
  return { rows, errors };
}
if (import.meta.main)
  writeFileSync(
    new URL("../../test/fixtures/sessions/routes-parity.json", import.meta.url),
    JSON.stringify(await recordRoutes(), null, 2) + "\n",
  );
