import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { StartSessionForm } from "../app/src/screens/StartSession";
import { sessionCreateParams } from "../app/src/model/start-session";
import { insertPastedText } from "../app/src/model/attachments";

test("mixed image and text paste preserves text at the selected prompt range", () => {
  expect(insertPastedText("Fix this please", "screenshot", 4, 8)).toBe(
    "Fix screenshot please",
  );
  expect(insertPastedText("keep", "", 0, 4)).toBe("keep");
});

test("session composer separates isolated branch from existing checkout and names agent/account", () => {
  const html = renderToString(
    <StartSessionForm
      request="Fix the tests"
      repo="repo"
      repos={[{ key: "repo", label: "project", path: "/tmp/project" }]}
      preparation={{
        repo: { key: "repo", label: "project", path: "/tmp/project" },
        branches: ["main"],
        base: "main",
        checkouts: [{ path: "/tmp/project", branch: "main", dirty: true }],
        executors: [
          {
            id: "codex",
            agent: "codex",
            account: "work",
            version: "0.163.0",
            available: true,
            capabilities: {
              interactive: true,
              resume: true,
              launchImages: true,
              liveImages: false,
              files: true,
            },
          },
        ],
      }}
      mode="new"
      base="main"
      checkout="/tmp/project"
      executor="codex"
      items={[]}
      busy={false}
      onField={() => {}}
      onFiles={() => {}}
      onRemove={() => {}}
      onRetry={() => {}}
      onSubmit={() => {}}
    />,
  );
  expect(html).toContain("New worktree");
  expect(html).toContain('class="pc-start-fields"');
  expect(html).toContain('pc-attachment-picker__trigger');
  expect(html).toContain('aria-haspopup="listbox"');
  expect(html).not.toContain('<select');
  expect(html).toContain("Base branch");
  expect(html).toContain("Codex · work");
  expect(html).toContain("Start session");
  expect(html).not.toContain("Done when");
  expect(html).not.toContain("Kind (optional)");
});
test("session creation sends explicit workspace and preserves prompt whitespace", () => {
  expect(
    sessionCreateParams(
      {
        request: "hello\n world",
        repo: "repo",
        executor: "codex",
        mode: "new",
        base: "main",
        checkout: "/tmp/r",
        draftId: "draft",
      },
      "request",
      ["image"],
    ),
  ).toEqual({
    request_id: "request",
    draftId: "draft",
    request: "hello\n world",
    repo: "repo",
    executor: "codex",
    workspace: { mode: "new", base: "main" },
    attachments: ["image"],
  });
});
