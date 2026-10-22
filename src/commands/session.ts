import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { connectClient } from "../api/client";
import { DEFAULT_PORT } from "../serve/constants";
import type { Command } from "./types";
import type { SessionPreparation } from "../session/capabilities";
export function parseSessionArgs(args: string[]) {
  const command = args[0],
    values: Record<string, string> = {},
    attachments: string[] = [];
  let json = false,
    request = "",
    id: string | undefined;
  if (!["start", "end", "resume"].includes(command ?? ""))
    throw Error("usage: pacer session start|end|resume");
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      request = args.slice(i + 1).join(" ");
      break;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (
      ["--repo", "--executor", "--base", "--checkout", "--attach"].includes(arg)
    ) {
      const value = args[++i];
      if (!value) throw Error(`${arg} requires a value`);
      if (arg === "--attach") attachments.push(value);
      else values[arg.slice(2)] = value;
    } else if (command !== "start" && !id && !arg.startsWith("-")) id = arg;
    else
      throw Error(
        `Unknown session argument: ${arg}. Put the initial prompt after --.`,
      );
  }
  if (values.base && values.checkout)
    throw Error("--base and --checkout are mutually exclusive");
  if (command === "start" && !request.trim())
    throw Error("Put your request after --");
  if (command !== "start" && !id) throw Error("A session ID is required");
  return {
    command: command!,
    ...values,
    repo: values.repo,
    executor: values.executor,
    base: values.base,
    checkout: values.checkout,
    attachments,
    request,
    id,
    json,
  };
}
export const COMMANDS: Command[] = [
  {
    name: "session",
    usage:
      "session start|end|resume           work interactively with an agent",
    run: async (args, ctx) => {
      let client: Awaited<ReturnType<typeof connectClient>> | undefined;
      try {
        const parsed = parseSessionArgs(args);
        client = await connectClient(ctx, { protocol: 3 });
        if (client.kind !== "http")
          throw Error("Start pacer serve before using interactive sessions.");
        let result: unknown;
        if (parsed.command !== "start") {
          const task = await client.call<{ rev: number }>("task.get", {
            id: parsed.id,
          });
          result = await client.call(`session.${parsed.command}`, {
            id: parsed.id,
            expect_rev: task.rev,
          });
        } else {
          const repo = parsed.repo ?? process.cwd(),
            preparation = await client.call<SessionPreparation>(
              "session.prepare",
              { repo },
            );
          const executor =
            preparation.executors.find((e) => e.id === parsed.executor) ||
            (!parsed.executor
              ? preparation.executors.find((e) => e.available)
              : undefined);
          if (!executor?.available)
            throw Error(executor?.reason ?? "No interactive executor is ready");
          const draft = await client.call<{ id: string }>(
              "session.draft.create",
              {},
            ),
            ids: string[] = [];
          const base = `http://127.0.0.1:${ctx.env.PACER_PORT ?? DEFAULT_PORT}`,
            token = readFileSync(join(ctx.pacerHome, "token"), "utf8").trim(),
            batch = crypto.randomUUID();
          for (const name of parsed.attachments) {
            const file = Bun.file(resolve(name)),
              response = await fetch(
                `${base}/v3/attachments?draft=${draft.id}&batch=${batch}`,
                {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${token}`,
                    "X-Pacer-Filename": encodeURIComponent(basename(name)),
                    "Content-Type": file.type || "application/octet-stream",
                  },
                  body: file,
                },
              );
            const value = (await response.json()) as {
              id: string;
              error?: { message: string };
            };
            if (!response.ok)
              throw Error(value.error?.message ?? "Upload failed");
            ids.push(value.id);
          }
          result = await client.call("session.create", {
            request_id: crypto.randomUUID(),
            draftId: draft.id,
            request: parsed.request,
            repo,
            executor: executor.id,
            workspace: parsed.checkout
              ? { mode: "current", path: parsed.checkout }
              : { mode: "new", base: parsed.base ?? preparation.base },
            attachments: ids,
          });
        }
        const taskId =
          (result as { task_id?: string; id?: string }).task_id ??
          (result as { id?: string }).id;
        return {
          code: 0,
          out: parsed.json
            ? JSON.stringify(result, null, 2)
            : parsed.command === "end"
              ? `Session ${taskId ?? parsed.id} ended.`
              : `Session ${taskId} started.\nRun: pacer attach ${taskId} --control`,
          err: "",
        };
      } catch (error) {
        return {
          code: 2,
          out: "",
          err: `pacer session: ${error instanceof Error ? error.message : String(error)}`,
        };
      } finally {
        client?.close();
      }
    },
  },
];
