import { expect, test } from "bun:test";
import { capabilities, prepare, attachment } from "../plugins/agent-session/index";

test("Codex attaches initial images as arguments while preserving ordinary permissions", () => {
  const image = {id: "a", name: "image.png", mime: "image/png", size: 12, path: "/tmp/session/image with spaces.png"};
  const launch = prepare({agent: "codex", version: "0.163.0", request: "--dangerous $(echo hi)", workspace: "/tmp/repo",
    runDir: "/tmp/session", attachments: [image], permissionPolicy: "native"});
  expect(launch.argv).toEqual(["codex", "--no-daemon", "-C", "/tmp/repo", "-s", "workspace-write", "--add-dir", "/tmp/session",
    "-i", "/tmp/session/image with spaces.png", "--", "--dangerous $(echo hi)"]);
});

test("unknown or unsupported agents report a reason before launch", () => {
  expect(capabilities({agent: "unknown", version: "1.0.0"})).toMatchObject({interactive: false, reason: expect.any(String)});
  expect(capabilities({agent: "codex", version: "0.100.0"})).toMatchObject({interactive: false});
  expect(() => prepare({agent: "unknown", version: "1.0.0", request: "hello", workspace: "/tmp/r", runDir: "/tmp/s", attachments: [], permissionPolicy: "native"})).toThrow();
});

test("later file attachment is an explicit reference without input submission", () => {
  const result = attachment({agent: "claude-code", version: "2.1.281", workspace: "/tmp/repo", phase: "live",
    attachment: {id: "a", name: "report.txt", mime: "text/plain", size: 20, path: "/tmp/session/a"}});
  expect(result).toEqual({kind: "reference", text: 'Use the attached file "report.txt" at "/tmp/session/a".', requiresUserSubmit: true});
  expect("args" in result).toBe(false);
});

test("Claude and OpenCode keep native permission prompts and model selection", () => {
  const base = {request: "hello", workspace: "/tmp/repo", runDir: "/tmp/session", attachments: [], permissionPolicy: "native" as const, model: "chosen"};
  expect(prepare({...base, agent: "claude-code", version: "2.1.281"}).argv).toEqual(["claude", "--add-dir", "/tmp/session", "--model", "chosen", "--", "hello"]);
  expect(prepare({...base, model: undefined, agent: "opencode", version: "2.1.2"}).argv).toEqual(["opencode", "--standalone", "--prompt", "hello", "/tmp/repo"]);
  expect(() => prepare({...base, agent: "opencode", version: "2.1.2"})).toThrow("model overrides");
});

test("adapter paths and request remain arguments rather than executable shell text", () => {
  const request = '日本語\n`touch evil`';
  const launch = prepare({agent: "claude-code", version: "2.1.281", request, workspace: "/tmp/r", runDir: "/tmp/s", attachments: [], permissionPolicy: "native"});
  expect(launch.argv.at(-1)).toBe(request);
  expect(launch.cwd).toBe("/tmp/r");
});
