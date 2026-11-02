/** Actual CLI command over a fixture HTTP API; captures orchestration, not service implementation. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../../src/commands/session";
import { fakeCtx } from "../../test/helpers";
export async function recordCliFlows() {
  const rows = [];
  for (const mode of [
    "start-new",
    "start-current",
    "start-json",
    "start-attachments",
    "upload-error",
    "end",
    "resume",
    "unavailable",
    "unknown-executor",
    "api-error",
    "executor-start",
    "executor-resume",
    "executor-end",
  ] as const) {
    const calls: unknown[] = [],
      ctx = fakeCtx({
        env: mode.startsWith("executor") ? { PACER_ROLE: "executor" } : {},
      });
    mkdirSync(ctx.pacerHome, { recursive: true });
    writeFileSync(join(ctx.pacerHome, "token"), "fixture");
    const attachment = join(ctx.home, "fixture.txt");
    writeFileSync(attachment, "fixture payload");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname === "/health")
          return Response.json({ ok: true }, { headers: { "X-Pacer": "1" } });
        if (new URL(req.url).pathname === "/v3/attachments") {
          calls.push({
            op: "upload",
            draft: new URL(req.url).searchParams.get("draft"),
            filename: req.headers.get("x-pacer-filename"),
            content: await req.text(),
          });
          return mode === "upload-error"
            ? Response.json(
                { error: { message: "Fixture upload failed" } },
                { status: 400 },
              )
            : Response.json({ id: "attachment-id" });
        }
        const op = decodeURIComponent(
          new URL(req.url).pathname.split("/").at(-1)!,
        );
        const params = (await req.json()) as any;
        calls.push({
          op,
          params: {
            ...params,
            ...(params.request_id ? { request_id: "<uuid>" } : {}),
          },
        });
        if (mode === "api-error")
          return Response.json(
            { error: { code: "conflict", message: "Fixture conflict" } },
            { status: 409 },
          );
        const result =
          op === "session.prepare"
            ? {
                executors: [
                  {
                    id: "codex",
                    available: mode !== "unavailable",
                    reason: "Fixture unavailable",
                  },
                ],
                base: "main",
              }
            : op === "session.draft.create"
              ? { id: "draft" }
              : op === "task.get"
                ? { rev: 7 }
                : op === "session.create"
                  ? { task_id: "task", state: "queued" }
                  : { id: "task" };
        return Response.json({ result });
      },
    });
    ctx.env.PACER_PORT = String(server.port);
    const args =
      mode === "end" || mode === "executor-end"
        ? ["end", "task"]
        : mode === "resume" || mode === "executor-resume"
          ? ["resume", "task"]
          : [
              "start",
              "--repo",
              "fixture-repo",
              ...(mode === "start-current" ? ["--checkout", "checkout"] : []),
              ...(mode === "unknown-executor" ? ["--executor", "missing"] : []),
              ...(mode === "start-json" ? ["--json"] : []),
              ...(["start-attachments", "upload-error"].includes(mode)
                ? ["--attach", attachment]
                : []),
              "--",
              "Initial prompt",
            ];
    try {
      rows.push({
        mode,
        args: args.map((arg) => (arg === attachment ? "<attachment>" : arg)),
        result: await COMMANDS[0]!.run(args, ctx),
        calls,
      });
    } finally {
      server.stop(true);
    }
  }
  return rows;
}
if (import.meta.main)
  writeFileSync(
    new URL(
      "../../test/fixtures/sessions/cli-flow-parity.json",
      import.meta.url,
    ),
    JSON.stringify(await recordCliFlows(), null, 2) + "\n",
  );
