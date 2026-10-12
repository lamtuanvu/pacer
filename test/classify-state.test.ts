import { expect, test } from "bun:test";
import { KINDS } from "../src/config/strategy";
import type { TaskRecord, TaskResult } from "../src/tasks/types";
import { HttpError, isLocalUrl, joinUrl, postJson } from "../src/classify/http";
import {
  KIND_CRITERIA, QUESTIONS, difficultyState, guardEventId, guardState,
  parseState, redactState, resultCheckState, stateHash, taskKindState, withoutPlannerKind,
} from "../src/classify/state";

const task: TaskRecord = {
  id: "t-one", createdAt: 0, kind: "tests", requestedExecutor: null,
  timeoutS: 60, brief: { goal: "Add tests", repo: "/repo" }, state: "queued", attempts: [],
};
const result: TaskResult = {
  status: "done", executor: "codex", model: null, report: "Completed", files: "a.ts",
  backend: "direct",
};

test("KIND_CRITERIA keys are the 11 KINDS plus default", () => {
  expect(Object.keys(KIND_CRITERIA).sort()).toEqual([...KINDS, "default"].sort());
  expect(KIND_CRITERIA.default).toBe("None of the above, or unclear");
  expect(Object.values(KIND_CRITERIA).every((v) => v.length > 0)).toBe(true);
  expect(QUESTIONS.task_kind).toEqual({ type: "choice", id: "task_kind", instructions: expect.any(String), criteria: KIND_CRITERIA });
  expect(QUESTIONS.difficulty).toEqual({ type: "score", id: "difficulty", min: 0, max: 1, instructions: "Can a mid-tier coding model complete this reliably? 1 = certainly" });
  expect(QUESTIONS.guard).toEqual({ type: "yesno", id: "guard", instructions: "Is this execution work (writing/changing code, running builds) rather than design, review or read-only research?" });
  expect(QUESTIONS.result_check).toEqual({ type: "yesno", id: "result_check", instructions: "Does this result satisfy the brief?" });
});

test("taskKindState drops undefined fields and trims context to 4000", () => {
  expect(JSON.parse(taskKindState(task))).toEqual({ goal: "Add tests", planner_kind: "tests" });
  const input = { ...task, brief: { ...task.brief, scope: "test/", constraints: "local only", context: "x".repeat(4001) } };
  expect(JSON.parse(taskKindState(input))).toEqual({ goal: "Add tests", scope: "test/", constraints: "local only", context: "x".repeat(4000), planner_kind: "tests" });
});

test("difficultyState adds kind, has_acceptance and repo_files", () => {
  expect(JSON.parse(difficultyState(task, null, null))).toEqual({ goal: "Add tests", planner_kind: "tests", kind: null, has_acceptance: false, repo_files: null });
  expect(JSON.parse(difficultyState({ ...task, brief: { ...task.brief, acceptance: "bun test", context: "c".repeat(4001) } }, "feature", 5010))).toEqual({ goal: "Add tests", context: "c".repeat(4000), planner_kind: "tests", kind: "feature", has_acceptance: true, repo_files: 5010 });
});

test("guardState drops undefined model and trims prompt to 4000", () => {
  expect(JSON.parse(guardState({ subagentType: "Explore", prompt: "read" }))).toEqual({ subagent_type: "Explore", prompt: "read" });
  expect(JSON.parse(guardState({ subagentType: "executor", prompt: "p".repeat(4001), model: "m" }))).toEqual({ subagent_type: "executor", prompt: "p".repeat(4000), model: "m" });
});

test("resultCheckState trims report and files to 2000 and acceptance tail to 1000", () => {
  expect(JSON.parse(resultCheckState(task, result))).toEqual({ goal: "Add tests", status: "done", report: "Completed", files: "a.ts" });
  const input = { ...result, report: "r".repeat(2001), files: "f".repeat(2001), acceptance: { cmd: "bun test", passed: false, tail: "t".repeat(1001) } };
  expect(JSON.parse(resultCheckState({ ...task, brief: { ...task.brief, scope: "src/" } }, input))).toEqual({ goal: "Add tests", scope: "src/", status: "done", report: "r".repeat(2000), files: "f".repeat(2000), acceptance: { cmd: "bun test", passed: false, tail: "t".repeat(1000) } });
});

test("stateHash is stable and uses the first 16 SHA256 hex characters", () => {
  expect(stateHash("abc")).toBe("ba7816bf8f01cfea");
  expect(stateHash("abc")).toMatch(/^[0-9a-f]{16}$/);
  expect(stateHash("abc")).toBe(stateHash("abc"));
  expect(stateHash("abcd")).not.toBe(stateHash("abc"));
});

test("guardEventId hashes the normalized guard state", () => {
  expect(guardEventId({ subagentType: "Explore", prompt: "read" })).toBe(stateHash('{"subagent_type":"Explore","prompt":"read"}'));
});

test("parseState and withoutPlannerKind preserve other fields", () => {
  const state = '{"goal":"Build","planner_kind":"feature","nested":{"planner_kind":"keep"}}';
  expect(parseState(state)).toEqual({ goal: "Build", planner_kind: "feature", nested: { planner_kind: "keep" } });
  expect(JSON.parse(withoutPlannerKind(state))).toEqual({ goal: "Build", nested: { planner_kind: "keep" } });
});

test("redactState recursively replaces home and cuts long strings to 200 plus ellipsis", () => {
  const state = JSON.stringify({ path: "/fake/home/repo /fake/home/file", nested: [{ text: "x".repeat(201), exact: "e".repeat(200) }, null, false, 42], longPath: "/fake/home/" + "a".repeat(200) });
  expect(JSON.parse(redactState(state, "/fake/home"))).toEqual({ path: "~/repo ~/file", nested: [{ text: "x".repeat(200) + "...", exact: "e".repeat(200) }, null, false, 42], longPath: "~/" + "a".repeat(198) + "..." });
});

function server(fetch: (request: Request) => Response | Promise<Response>) {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
}

test("postJson sends JSON and custom headers and returns 200 JSON", async () => {
  const app = server(async (request) => Response.json({ body: await request.json(), type: request.headers.get("content-type"), auth: request.headers.get("authorization"), method: request.method }));
  try {
    expect(await postJson<Record<string, unknown>>(app.url.href, { hello: "world" }, { headers: { Authorization: "Bearer fake" }, timeoutMs: 1000 })).toEqual({ body: { hello: "world" }, type: "application/json", auth: "Bearer fake", method: "POST" });
  } finally { app.stop(true); }
});

test("postJson throws HttpError with status and body for 500", async () => {
  const app = server(() => new Response("unavailable", { status: 500 }));
  try {
    const error = await postJson(app.url.href, {}, { timeoutMs: 1000 }).catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    if (!(error instanceof HttpError)) throw new Error("Expected an HttpError");
    expect(error.status).toBe(500);
    expect(error.body).toBe("unavailable");
  } finally { app.stop(true); }
});

test("postJson rejects malformed JSON", async () => {
  const app = server(() => new Response("not json"));
  try { await expect(postJson(app.url.href, {}, { timeoutMs: 1000 })).rejects.toThrow(); }
  finally { app.stop(true); }
});

test("postJson rejects a slow handler beyond timeoutMs", async () => {
  const app = server(async () => { await Bun.sleep(150); return Response.json({ ok: true }); });
  try { await expect(postJson(app.url.href, {}, { timeoutMs: 10 })).rejects.toThrow(); }
  finally { app.stop(true); }
});

test("joinUrl strips trailing base slashes", () => {
  expect(joinUrl("http://127.0.0.1:1234/v1///", "/chat/completions")).toBe("http://127.0.0.1:1234/v1/chat/completions");
  expect(joinUrl("https://example.com", "v1/systemone")).toBe("https://example.com/v1/systemone");
});

test("isLocalUrl recognizes loopback and localhost subdomains only", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]", "x.localhost"]) expect(isLocalUrl(`http://${host}:1234/v1`)).toBe(true);
  for (const url of ["https://example.com", "http://localhost.example.com", "http://notlocalhost", "invalid"]) expect(isLocalUrl(url)).toBe(false);
});
