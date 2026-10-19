import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { Delegate, DelegateRoutingPreview, handleDelegateKey } from "../app/src/screens/Delegate";
import { blankDelegate, delegateParams, delegateRoutingParams, initialDelegateDraft } from "../app/src/model/tasks";
import { TaskContext } from "../app/src/screens/task-shared";
import { initialState } from "../app/src/data/store";
import { draftStorage } from "../app/src/model/draft";

const apiRepo = "github.com/acme/api", webRepo = "github.com/acme/web";
test("delegate defaults to the active filter, then draft, then last successfully used repo", () => {
  const saved = { ...blankDelegate, repo: apiRepo, base: "release", goal: "Fix routing" };
  expect(initialDelegateDraft(saved, webRepo, apiRepo)).toMatchObject({ repo: webRepo, base: "", goal: "Fix routing" });
  expect(initialDelegateDraft(saved, null, webRepo)).toEqual(saved);
  expect(initialDelegateDraft(blankDelegate, null, webRepo).repo).toBe(webRepo);
  expect(initialDelegateDraft(blankDelegate, null).repo).toBe("");
  expect(initialDelegateDraft(saved, apiRepo).base).toBe("release");
});
test("remembered repo survives clearing the task draft and tolerates unavailable storage", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const draft = draftStorage("draft", blankDelegate, storage);
  const last = draftStorage("last", { repo: "" }, storage);
  draft.write({ ...blankDelegate, repo: webRepo, goal: "Fix routing" });
  last.write({ repo: webRepo });
  draft.clear();
  expect(initialDelegateDraft(draft.read(), null, last.read().repo).repo).toBe(webRepo);
  const denied = draftStorage("last", { repo: "" }, { ...storage, getItem() { throw new Error("denied"); } });
  expect(initialDelegateDraft(blankDelegate, apiRepo, denied.read().repo).repo).toBe(apiRepo);
});
test("kind and repo feed the routing preview and delegate request; automatic kind is omitted", () => {
  const draft = { ...blankDelegate, repo: apiRepo, goal: "Write tests", kind: "tests" };
  expect(delegateRoutingParams(draft, true, draft.goal)).toEqual({ repo: apiRepo, goal: draft.goal, kind: "tests" });
  expect(delegateRoutingParams({ ...draft, repo: webRepo, kind: "docs" }, true, "Update docs")).toEqual({ repo: webRepo, goal: "Update docs", kind: "docs" });
  expect(delegateParams(draft, new Set(["repo.list"]), "req", [apiRepo])).toMatchObject({ repo: apiRepo, kind: "tests", goal: draft.goal });
  expect(delegateParams({ ...draft, kind: "" }, new Set(["repo.list"]), "req", [apiRepo])).not.toHaveProperty("kind");
  expect(delegateRoutingParams(blankDelegate, true, "")).toEqual({});
  expect(delegateRoutingParams(draft, false, draft.goal)).toEqual({ kind: "tests" });
});
test("routing preview names the next executor and reflects explicit selection and pending reads", () => {
  const routing = { ranked: [{ id: "codex", verdict: "OK", reason: "Ready" }], excluded: [] };
  const render = (executor = "", loading = false) => renderToString(<DelegateRoutingPreview routing={routing} executor={executor} loading={loading} />);
  expect(render()).toContain("Goes to Codex now · next in line");
  expect(render()).toContain('aria-live="polite"');
  expect(render("claude-code")).toContain("Goes to Claude Code · selected executor");
  expect(render("", true)).toContain("Checking routing…");
  expect(render("", true)).not.toContain("Goes to Codex");
  expect(renderToString(<DelegateRoutingPreview routing={{ ranked: [], excluded: [] }} executor="" />)).toContain("No executor available now.");
});
test("Cmd+Enter and Ctrl+Enter request form submission once; typing, composition and busy state do not", () => {
  let submitted = 0, prevented = 0;
  const event = { key: "Enter", metaKey: false, ctrlKey: false, isComposing: false, repeat: false, preventDefault() { prevented++; }, stopPropagation() {} };
  const submit = () => submitted++;
  handleDelegateKey(event, submit);
  handleDelegateKey({ ...event, metaKey: true, isComposing: true }, submit);
  expect(submitted).toBe(0);
  expect(prevented).toBe(0);
  handleDelegateKey({ ...event, metaKey: true }, submit);
  handleDelegateKey({ ...event, ctrlKey: true }, submit);
  expect(submitted).toBe(2);
  handleDelegateKey({ ...event, metaKey: true }, submit, true);
  handleDelegateKey({ ...event, metaKey: true, repeat: true }, submit);
  expect(submitted).toBe(2);
});

test("dialog renders stored defaults, optional kind and submission shortcut", () => {
  const oldSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const oldLocal = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = (value: unknown) => ({ getItem: () => JSON.stringify(value), setItem() {}, removeItem() {} });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage({ ...blankDelegate, goal: "Fix routing", kind: "tests" }) });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage({ repo: "/tmp/fixture/api" }) });
  try {
    const api = { hello: async () => ({}) as never, snapshot: async () => ({}) as never, call: async <T,>() => ({}) as T };
    const render = (filterRepo: string | null) => renderToString(<TaskContext.Provider value={{ state: initialState(), api }}><Delegate close={() => {}} filterRepo={filterRepo} /></TaskContext.Provider>);
    expect(render(null)).toContain('value="/tmp/fixture/api"');
    const html = render("/tmp/fixture/web");
    expect(html).toContain('value="/tmp/fixture/web"');
    expect(html).toContain("Fix routing");
    expect(html).toContain("Kind (optional)");
    expect(html).toMatch(/<option selected value="tests"/);
    expect(html).toContain('aria-keyshortcuts="Meta+Enter Control+Enter"');
    expect(html).toContain("Checking routing…");
  } finally {
    if (oldSession) Object.defineProperty(globalThis, "sessionStorage", oldSession); else Reflect.deleteProperty(globalThis, "sessionStorage");
    if (oldLocal) Object.defineProperty(globalThis, "localStorage", oldLocal); else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
