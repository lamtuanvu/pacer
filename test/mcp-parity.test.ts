import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tmpDir } from "./helpers";
import { fakeCtx } from "./helpers";
import { createTask, updateTask } from "../src/tasks/store";
import { issueWorkGrant, registerWork } from "../src/dispatch/work";
import { startServer } from "../src/serve/http";

// Captured from the TypeScript `pacer mcp` stdio entry point in both session modes.
// A future native MCP server must match the complete tool contracts and these wire results.
const goldenPath = join(import.meta.dir, "fixtures", "mcp", "ts-stdio-golden.json");
type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
const validationCases = [
  // Raw spellings are inserted into JSON-RPC frames below, before JSON parsing.
  { name: "delegate", field: "acceptance_timeout_min", raw: "1.0", accepted: true },
  { name: "delegate", field: "acceptance_timeout_min", raw: "1e2", accepted: true },
  { name: "delegate", field: "acceptance_timeout_min", value: 1.5, accepted: false },
  { name: "delegate", field: "acceptance_timeout_min", value: 121, accepted: false },
  { name: "msg_wait", field: "timeout_s", raw: "1e0", accepted: true },
  { name: "msg_wait", field: "timeout_s", value: 3001, accepted: false },
  { name: "task_wait", field: "timeout_s", raw: "1.0", accepted: true },
  { name: "task_wait", field: "timeout_s", raw: "1e2", accepted: true },
  { name: "task_wait", field: "timeout_s", value: 1.5, accepted: false },
  { name: "task_wait", field: "timeout_s", value: 0, accepted: false },
  { name: "task_wait", field: "timeout_s", value: 3001, accepted: false },
  { name: "task_review", field: "expect_rev", raw: "1.0", accepted: true },
  { name: "task_review", field: "expect_rev", value: 0, accepted: false },
  { name: "task_review", field: "expect_rev", value: 9007199254740992, accepted: false },
  { name: "task_stop", field: "expect_rev", raw: "1e2", accepted: true },
  { name: "task_stop", field: "expect_rev", value: 9007199254740992, accepted: false },
  { name: "work_answer", field: "expect_rev", raw: "1.0", accepted: true },
  { name: "work_answer", field: "expect_rev", value: 9007199254740992, accepted: false },
  { name: "work_retry", field: "expect_rev", raw: "1e2", accepted: true },
  { name: "work_retry", field: "expect_rev", value: 9007199254740992, accepted: false },
  { name: "work_events", field: "after", raw: "1e2", accepted: true },
  { name: "work_events", field: "after", value: -1, accepted: false },
  { name: "work_events", field: "after", value: 9007199254740992, accepted: false },
  // Zod string bounds count Unicode code points; JS .length would count each emoji twice.
  { name: "work_answer", field: "text", value: "😀".repeat(2000), accepted: true },
  { name: "work_answer", field: "text", value: "😀".repeat(2001), accepted: false },
  { name: "work_answer", field: "text", value: "", accepted: false },
  { name: "work_retry", field: "feedback", value: "😀".repeat(2000), accepted: true },
  { name: "work_retry", field: "feedback", value: "😀".repeat(2001), accepted: false },
  { name: "task_send", field: "text", value: "😀".repeat(4000), accepted: true },
  { name: "task_send", field: "text", value: "😀".repeat(4001), accepted: false },
  { name: "task_answer", field: "text", value: "😀".repeat(2000), accepted: true },
  { name: "task_answer", field: "text", value: "😀".repeat(2001), accepted: false },
  { name: "task_request_review", field: "note", value: "\uFEFFok\uFEFF", accepted: true },
  { name: "task_request_review", field: "note", value: "\uFEFF", accepted: false },
  { name: "task_request_review", field: "note", value: "😀".repeat(2000), accepted: true },
  { name: "task_request_review", field: "note", value: "😀".repeat(2001), accepted: false },
  { name: "msg_send", field: "body", value: "\uFEFF", accepted: true },
  { name: "msg_send", field: "body", value: "", accepted: false },
  { name: "msg_read", field: "ids", value: ["id"], accepted: true },
  { name: "msg_read", field: "ids", value: [], accepted: false },
  { name: "delegate", field: "title", value: "😀".repeat(60), accepted: true },
  { name: "delegate", field: "title", value: "😀".repeat(61), accepted: false },
  { name: "delegate", field: "request_id", value: "😀".repeat(128), accepted: true },
  { name: "delegate", field: "request_id", value: "😀".repeat(129), accepted: false },
  { name: "delegate", field: "title", value: "\uFEFF", accepted: false },
  { name: "delegate", field: "worktree_reason", value: "😀".repeat(200), accepted: true },
  { name: "delegate", field: "worktree_reason", value: "😀".repeat(201), accepted: false },
  { name: "delegate", field: "timeout_min", raw: "1e2", accepted: true },
  { name: "delegate", field: "timeout_min", raw: "1e400", accepted: false },
  { name: "delegate", field: "acceptance_timeout_min", raw: "1e400", accepted: false },
  { name: "task_send", field: "expect_rev", raw: "1e2", accepted: true },
  { name: "task_send", field: "expect_rev", raw: "1.5", accepted: false },
  { name: "task_send", field: "expect_rev", raw: "9007199254740992", accepted: false },
  { name: "task_answer", field: "expect_rev", raw: "1.0", accepted: true },
  { name: "task_answer", field: "expect_rev", raw: "0", accepted: false },
  { name: "task_answer", field: "expect_rev", raw: "9007199254740992", accepted: false },
  { name: "task_request_review", field: "expect_rev", raw: "1e2", accepted: true },
  { name: "task_request_review", field: "expect_rev", raw: "0", accepted: false },
  { name: "task_request_review", field: "expect_rev", raw: "9007199254740992", accepted: false },
  { name: "task_review", field: "expect_rev", raw: "1e2", accepted: true },
  { name: "task_review", field: "expect_rev", raw: "1.5", accepted: false },
  { name: "task_review", field: "expect_rev", raw: "9007199254740992", accepted: false },
  { name: "report_limit", field: "until", raw: "1e2", accepted: true },
  { name: "report_limit", field: "until", raw: "1e400", accepted: false },
  { name: "delegate", field: "requestId", value: "😀".repeat(129), accepted: true },
  ...([
    ["requirements.context", 1, 9007199254740991],
    ["messaging.max_turns", 1, 10000],
    ["messaging.liveness.interval_s", 10, 9007199254740991],
    ["messaging.liveness.max_nudges", 0, 9007199254740991],
    ["messaging.liveness.escalate_after_s", 10, 9007199254740991],
    ["messaging.rules[].limits.per_minute", 1, 9007199254740991],
    ["messaging.rules[].limits.max_bytes", 1, 1048576],
  ] as const).flatMap(([path, min, max]) => {
    const wrap = (number: string) => {
      const leaf = path.split(".").at(-1)!;
      if (path.startsWith("requirements")) return `{"context":${number}}`;
      if (path.includes("rules[]")) return `{"rules":[{"effect":"allow","limits":{"${leaf}":${number}}}]}`;
      if (path.includes("liveness")) return `{"liveness":{"${leaf}":${number}}}`;
      return `{"max_turns":${number}}`;
    };
    return [[`${min}.0`, true], ["1e2", true], ["10.5", false], [String(min - 1), false], [String(max), true], [String(max + 1), false]]
      .map(([value, accepted]) => ({ name: path.startsWith("requirements") ? "dispatch_preview" : "delegate", field: path.startsWith("requirements") ? "requirements" : "messaging", raw: wrap(String(value)), accepted: Boolean(accepted), numericPath: path }));
  }),
  { name: "delegate", field: "title", value: "😀".repeat(61), accepted: true, grantOnly: true },
  ...["\uFEFF", "\u2028", "\u2029", "\u00A0", "\u1680", ...Array.from({length:11}, (_, i) => String.fromCodePoint(0x2000 + i)), "\u202F", "\u205F", "\u3000"].flatMap(space => [
    { name: "task_request_review", field: "note", value: space, accepted: false },
    { name: "delegate", field: "title", value: `${space}a${space}`, accepted: true },
    { name: "msg_send", field: "body", value: space, accepted: true },
  ]),
] as const;

function validationArgs(name: string): Record<string, unknown> {
  switch (name) {
    case "delegate": return { goal: "g", requestId: "r", repo: "relative" };
    case "dispatch_preview": return { goal: "g", repo: "relative" };
    case "msg_wait": return {};
    case "task_wait": return { task_id: "missing" };
    case "task_review": return { task_id: "missing", accepted: true, expect_rev: 1 };
    case "task_stop": return { task_id: "missing" };
    case "work_events": return { task_id: "missing" };
    case "work_answer": return { task_id: "missing", expect_rev: 1, requestId: "r", text: "ok" };
    case "work_retry": return { task_id: "missing", expect_rev: 1, requestId: "r" };
    case "task_send": case "task_answer": case "task_request_review": return { task_id: "missing", text: "ok", note: "ok" };
    case "report_limit": return { provider: "missing" };
    case "msg_send": return { to: "human", body: "ok" };
    case "msg_read": return { ids: ["id"] };
    default: throw new Error(`unknown validation tool ${name}`);
  }
}

// The SDK normalizes JSON numbers when it serializes arguments. This transport
// writes a literal tools/call frame so spelling-sensitive decoder ports are tested.
async function rawValidation(env: Record<string, string>, cases: readonly (typeof validationCases)[number][]) {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "mcp"], {
    cwd: join(import.meta.dir, ".."), env, stdin: "pipe", stdout: "pipe", stderr: "ignore",
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  async function response(): Promise<Record<string, any>> {
    while (true) {
      const end = pending.indexOf("\n");
      if (end >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (line.trim()) return JSON.parse(line);
      }
      const next = await reader.read();
      if (next.done) throw new Error("MCP stdio closed before response");
      pending += decoder.decode(next.value, { stream: true });
    }
  }
  async function send(frame: string) { proc.stdin.write(frame + "\n"); return response(); }
  const validation = [];
  try {
    await send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw-golden", version: "1" },
    } }));
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    for (const [index, row] of cases.entries()) {
      const raw = "raw" in row ? row.raw : JSON.stringify(row.value);
      const args = JSON.stringify(row.name === "task_review" && !env.PACER_WORK_GRANT
        ? { task_id: "missing", verdict: "accept" }
        : row.name === "delegate" && env.PACER_WORK_GRANT
          ? { goal: "g", requestId: "r", kind: "invalid-kind" } : validationArgs(row.name));
      const frame = `{"jsonrpc":"2.0","id":${index + 2},"method":"tools/call","params":{"name":${JSON.stringify(row.name)},"arguments":${args.slice(0, -1)}${args === "{}" ? "" : ","}${JSON.stringify(row.field)}:${raw}}}}`;
      const reply = await send(frame);
      const result = reply.result as ToolResult | undefined;
      const message = (result?.content as Array<{type:string;text?:string}> | undefined)?.find(part => part.type === "text")?.text ?? "";
      const validationError = reply.error?.code === -32602 || message.includes("Input validation error");
      if (validationError === row.accepted) throw new Error(`Unexpected validation for ${row.name}.${row.field}: ${raw}; ${message}`);
      if (row.accepted) {
        expect(validationError).toBe(false);
        if (result?.isError) expect(message).toMatch(/unknown task|Unknown managed work|Scoped request failed|forbidden|repo must|not available|not found|Message body is empty|Invalid participant|cannot|[Aa]nswer must contain|Feedback must contain|review request needs|Invalid task|not_allowed|Unknown task|Invalid message|no strategy found|unknown provider|unknown kind|Cannot resolve the parent worktree commit|outside the delegated subtree|requestId: Too big/);
        else expect(result?.structuredContent).toBeDefined();
      } else {
        expect(validationError).toBe(true);
        expect(reply.error?.code === -32602 || message.includes("Input validation error")).toBe(true);
      }
      const value = "raw" in row ? row.raw : row.value;
      validation.push({ name: row.name, field: row.field,
        input: typeof value === "string" && !("raw" in row)
          ? { codePoints: [...value].length, utf16Units: value.length,
            ...(value.length <= 4 ? { hex: [...value].map(c => c.codePointAt(0)!.toString(16)) } : {}) }
          : Array.isArray(value) ? { length: value.length } : value,
        acceptedBySchema: !validationError,
        response: { isError: result?.isError ?? false,
          ...(reply.error ? { errorCode: reply.error.code } : {}),
          message: message.slice(0, 160),
          ...(result?.structuredContent ? { structuredContent: result.structuredContent } : {}) } });
    }
    return validation;
  } finally {
    proc.stdin.end();
    reader.releaseLock();
    await proc.exited;
  }
}

async function capture(mode: "planner" | "grant") {
  const home = tmpDir();
  const pacerHome = join(home, ".pacer");
  mkdirSync(pacerHome, { recursive: true });
  const ctx = fakeCtx({ home, pacerHome, now: 1_900_000_000 });
  writeFileSync(join(pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: { usage: reactive }\n  cursor: {}\n");
  const task = createTask(ctx, { brief: { goal: "golden task", repo: home }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  registerWork(ctx, task.id, { allowDelegation: true });
  updateTask(ctx, task.id, t => { t.state = "running"; });
  const server = mode === "grant" ? startServer(() => ctx, { port: 0, listener: false, pumpMs: 0 }) : null;
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.HOME = home;
  env.PACER_HOME = pacerHome;
  delete env.PACER_ROLE;
  delete env.PACER_TASK_ID;
  delete env.PACER_WORK_GRANT;
  if (server) {
    env.PACER_WORK_GRANT = issueWorkGrant(ctx, task.id, 1);
    env.PACER_PORT = String(server.port);
  }
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
      { name: "task_status", args: { task_id: task.id } },
      { name: "budget_status", args: {} },
      { name: "route", args: {} },
      { name: "msg_inbox", args: {} },
      { name: "strategy_list", args: {} },
      { name: "delegate", args: { goal: "g", repo: "relative" } },
      { name: "task_wait", args: { task_id: "task-1", timeout_s: 0 } },
      { name: "work_answer", args: { task_id: "task-1", expect_rev: 1, requestId: "r", text: "" } },
      { name: "strategy_save", args: { name: "bad/name", draft: { from: "default" }, reason: "r" } },
    ] : [
      { name: "task_status", args: { task_id: task.id } },
      { name: "work_tree", args: { task_id: task.id } },
      { name: "work_events", args: { task_id: task.id } },
      { name: "msg_inbox", args: {} },
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
    const validation = await rawValidation(env, validationCases.filter(row =>
      mode === "planner" ? !("grantOnly" in row) && ["task_send", "task_answer", "task_request_review", "task_review", "task_wait", "work_answer", "work_retry", "msg_wait", "report_limit", "msg_send", "msg_read", "delegate", "dispatch_preview"].includes(row.name) && row.field !== "requestId"
        : !["task_send", "task_answer", "task_request_review", "report_limit", "dispatch_preview"].includes(row.name) && !(row.name === "delegate" && !["acceptance_timeout_min", "requestId"].includes(row.field) && !(row.field === "title" && "grantOnly" in row))));
    function numericPaths(schema: any, path = ""): string[] {
      if (!schema || typeof schema !== "object") return [];
      if (["number", "integer"].includes(schema.type)) return [path];
      return [
        ...Object.entries(schema.properties ?? {}).flatMap(([key, child]) => numericPaths(child, path ? `${path}.${key}` : key)),
        ...numericPaths(schema.items, `${path}[]`),
        ...(schema.anyOf ?? []).flatMap((child: unknown) => numericPaths(child, path)),
      ];
    }
    const numericFields = tools.flatMap(tool => numericPaths(tool.inputSchema).map(path => `${tool.name}.${path}`)).sort();
    const covered = validationCases.map(row => `${row.name}.${"numericPath" in row ? row.numericPath : row.field}`);
    expect([...new Set(covered)].filter(key => numericFields.includes(key)).sort()).toEqual(numericFields);
    const homePattern = new RegExp(`t-[A-Za-z0-9]{6}`, "g");
    const normalize = (value: unknown): any => {
      if (typeof value === "string") return value.replaceAll(realpathSync(home), "$HOME").replaceAll(home, "$HOME")
        .replaceAll(task.id, "task-fixture").replace(/local:[0-9a-f]{12}/g, "local:fixture")
        .replace(/("(?:generatedAt|evaluatedAt|capturedAt)":\s*)-?\d+(?:\.\d+)?/g, "$10")
        .replace(homePattern, "t-fixture-home");
      if (Array.isArray(value)) return value.map(normalize);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
        [key, ["generatedAt", "evaluatedAt", "capturedAt"].includes(key) && typeof item === "number" ? 0 : normalize(item)]));
      return value;
    };
    const normalizedResults = results.map(row => normalize(row));
    return { tools, results: normalizedResults, validation: normalize(validation) };
  } finally {
    await client.close();
    await transport.close();
    await server?.stop();
  }
}

test("TypeScript planner and grant MCP stdio tool contracts and results match captured goldens", async () => {
  const observed = { planner: await capture("planner"), grant: await capture("grant") };
  if (process.env.PACER_UPDATE_MCP_GOLDENS === "1") {
    mkdirSync(join(import.meta.dir, "fixtures", "mcp"), { recursive: true });
    writeFileSync(goldenPath, JSON.stringify(observed, null, 2) + "\n");
  }
  expect(observed).toEqual(JSON.parse(readFileSync(goldenPath, "utf8")));
}, 30_000);
