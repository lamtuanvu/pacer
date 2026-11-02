import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tmpDir } from "./helpers";

// Captured from the TypeScript `pacer mcp` stdio entry point in both session modes.
// A future native MCP server must match the complete tool contracts and these wire results.
const goldenPath = join(import.meta.dir, "fixtures", "mcp", "ts-stdio-golden.json");
type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
const validationCases = [
  // JSON number spelling is erased by parsing; these are still integers to JavaScript.
  { name: "delegate", field: "acceptance_timeout_min", value: JSON.parse("1.0"), accepted: true },
  { name: "delegate", field: "acceptance_timeout_min", value: JSON.parse("1e2"), accepted: true },
  { name: "delegate", field: "acceptance_timeout_min", value: 1.5, accepted: false },
  { name: "delegate", field: "acceptance_timeout_min", value: 121, accepted: false },
  { name: "msg_wait", field: "timeout_s", value: JSON.parse("1e2"), accepted: true },
  { name: "msg_wait", field: "timeout_s", value: 3001, accepted: false },
  { name: "task_wait", field: "timeout_s", value: JSON.parse("1.0"), accepted: true },
  { name: "task_wait", field: "timeout_s", value: JSON.parse("1e2"), accepted: true },
  { name: "task_wait", field: "timeout_s", value: 1.5, accepted: false },
  { name: "task_wait", field: "timeout_s", value: 0, accepted: false },
  { name: "task_wait", field: "timeout_s", value: 3001, accepted: false },
  { name: "task_review", field: "expect_rev", value: JSON.parse("1.0"), accepted: true },
  { name: "task_review", field: "expect_rev", value: 0, accepted: false },
  { name: "task_review", field: "expect_rev", value: 9007199254740992, accepted: false },
  { name: "task_stop", field: "expect_rev", value: JSON.parse("1e2"), accepted: true },
  { name: "task_stop", field: "expect_rev", value: 9007199254740992, accepted: false },
  { name: "work_answer", field: "expect_rev", value: JSON.parse("1.0"), accepted: true },
  { name: "work_answer", field: "expect_rev", value: 9007199254740992, accepted: false },
  { name: "work_retry", field: "expect_rev", value: JSON.parse("1e2"), accepted: true },
  { name: "work_retry", field: "expect_rev", value: 9007199254740992, accepted: false },
  { name: "work_events", field: "after", value: JSON.parse("1e2"), accepted: true },
  { name: "work_events", field: "after", value: -1, accepted: false },
  { name: "work_events", field: "after", value: 9007199254740992, accepted: false },
  // Zod string bounds count Unicode code points; JS .length would count each emoji twice.
  { name: "work_answer", field: "text", value: "😀".repeat(2000), accepted: true },
  { name: "work_answer", field: "text", value: "😀".repeat(2001), accepted: false },
  { name: "work_answer", field: "text", value: "", accepted: false },
  { name: "work_retry", field: "feedback", value: "😀".repeat(2000), accepted: true },
  { name: "work_retry", field: "feedback", value: "😀".repeat(2001), accepted: false },
] as const;

function validationArgs(name: string): Record<string, unknown> {
  switch (name) {
    case "delegate": return { goal: "g", requestId: "r" };
    case "msg_wait": return {};
    case "task_wait": return { task_id: "missing" };
    case "task_review": return { task_id: "missing", accepted: true, expect_rev: 1 };
    case "task_stop": return { task_id: "missing" };
    case "work_events": return { task_id: "missing" };
    case "work_answer": return { task_id: "missing", expect_rev: 1, requestId: "r", text: "ok" };
    case "work_retry": return { task_id: "missing", expect_rev: 1, requestId: "r" };
    default: throw new Error(`unknown validation tool ${name}`);
  }
}

async function capture(mode: "planner" | "grant") {
  const home = tmpDir();
  const pacerHome = join(home, ".pacer");
  mkdirSync(pacerHome, { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.HOME = home;
  env.PACER_HOME = pacerHome;
  delete env.PACER_ROLE;
  delete env.PACER_TASK_ID;
  delete env.PACER_WORK_GRANT;
  if (mode === "grant") env.PACER_WORK_GRANT = "fixture-grant";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "..", "src", "cli.ts"), "mcp"],
    env,
    cwd: join(import.meta.dir, ".."),
    stderr: "pipe",
  });
  const client = new Client({ name: "mcp-parity", version: "1" });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map(({ name, description, inputSchema, outputSchema }) => ({
      name, description, inputSchema, ...(outputSchema ? { outputSchema } : {}),
    })).sort((a, b) => a.name.localeCompare(b.name));
    const cases = mode === "planner" ? [
      { name: "guard_feedback", args: { event_id: "event-1", correct: true } },
      { name: "delegate", args: { goal: "g", repo: "relative" } },
      { name: "task_wait", args: { task_id: "task-1", timeout_s: 0 } },
      { name: "work_answer", args: { task_id: "task-1", expect_rev: 1, requestId: "r", text: "" } },
      { name: "strategy_save", args: { name: "bad/name", draft: { from: "default" }, reason: "r" } },
    ] : [
      { name: "delegate", args: { goal: "", requestId: "r" } },
      { name: "task_wait", args: { task_id: "task-1", timeout_s: 3001 } },
      { name: "work_answer", args: { task_id: "task-1", expect_rev: 1, requestId: "r", text: "" } },
      { name: "msg_read", args: { ids: [] } },
    ];
    const results = [];
    for (const row of cases) {
      const result = await client.callTool({ name: row.name, arguments: row.args }) as ToolResult;
      results.push({ name: row.name, args: row.args, result: {
        isError: result.isError ?? false,
        content: result.content,
        ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
      } });
    }
    const validation = [];
    if (mode === "grant") {
      for (const row of validationCases) {
        const result = await client.callTool({ name: row.name, arguments: { ...validationArgs(row.name), [row.field]: row.value } }) as ToolResult;
        const content = result.content as Array<{ type: string; text?: string }>;
        const message = content.find(part => part.type === "text")?.text ?? "";
        const acceptedBySchema = !message.includes("Input validation error");
        expect(acceptedBySchema).toBe(row.accepted);
        validation.push({ name: row.name, field: row.field,
          input: typeof row.value === "string"
            ? { codePoints: [...row.value].length, utf16Units: row.value.length }
            : row.value,
          acceptedBySchema });
      }
    }
    return { tools, results, ...(mode === "grant" ? { validation } : {}) };
  } finally {
    await client.close();
    await transport.close();
  }
}

test("TypeScript planner and grant MCP stdio tool contracts and results match captured goldens", async () => {
  const observed = { planner: await capture("planner"), grant: await capture("grant") };
  if (process.env.PACER_UPDATE_MCP_GOLDENS === "1") {
    mkdirSync(join(import.meta.dir, "fixtures", "mcp"), { recursive: true });
    writeFileSync(goldenPath, JSON.stringify(observed, null, 2) + "\n");
  }
  expect(observed).toEqual(JSON.parse(readFileSync(goldenPath, "utf8")));
});
