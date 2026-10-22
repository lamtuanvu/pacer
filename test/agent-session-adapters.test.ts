import { expect, test } from "bun:test";
import { capabilities, prepare, attachment } from "../plugins/agent-session/index";

test("Codex resume restores its identity without replaying the initial image or prompt", () => {
  const launch = prepare({agent: "codex", version: "0.163.0", request: "original", sessionId: "01a15fa2-5a28-7bb0-9b62-6a4434975b55", workspace: "/tmp/repo", runDir: "/tmp/run", permissionPolicy: "native", attachments: [{id: "image", name: "screen.png", mime: "image/png", size: 1, path: "/tmp/run/image"}]});
  expect(launch.argv.slice(-2)).toEqual(["--", "01a15fa2-5a28-7bb0-9b62-6a4434975b55"]);
  expect(launch.argv).not.toContain("-i");
  expect(launch.argv).not.toContain("/tmp/run/image");
  expect(launch.argv).not.toContain("original");
});

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
  expect(capabilities({agent: "codex", version: "0.163.0"})).toMatchObject({interactive: true, resume: true, launchImages: true});
  for (const [agent, version] of [["codex", "0.163.1"], ["claude-code", "2.1.281"], ["opencode", "2.1.2"], ["cursor", "2026.01.28-fd13201"]]) {
    expect(capabilities({agent, version})).toMatchObject({interactive: false, reason: expect.any(String)});
  }
  expect(() => prepare({agent: "unknown", version: "1.0.0", request: "hello", workspace: "/tmp/r", runDir: "/tmp/s", attachments: [], permissionPolicy: "native"})).toThrow();
});

test("later file attachment is an explicit reference without input submission", () => {
  const result = attachment({agent: "codex", version: "0.163.0", workspace: "/tmp/repo", phase: "live",
    attachment: {id: "a", name: "report.txt", mime: "text/plain", size: 20, path: "/tmp/session/a"}});
  expect(result).toEqual({kind: "reference", text: 'Use the attached file "report.txt" at "/tmp/session/a".', requiresUserSubmit: true});
  expect("args" in result).toBe(false);
});

test("unvalidated agents cannot launch interactive conversations", () => {
  const base = {request: "hello", workspace: "/tmp/repo", runDir: "/tmp/session", attachments: [], permissionPolicy: "native" as const, model: "chosen"};
  expect(() => prepare({...base, agent: "claude-code", version: "2.1.281"})).toThrow("Codex 0.163.0 only");
  expect(() => prepare({...base, model: undefined, agent: "opencode", version: "2.1.2"})).toThrow("Codex 0.163.0 only");
  expect(() => prepare({...base, agent: "cursor", version: "2026.01.28-fd13201"})).toThrow("Codex 0.163.0 only");
});

test("adapter paths and request remain arguments rather than executable shell text", () => {
  const request = '日本語\n`touch evil`';
  const launch = prepare({agent: "codex", version: "0.163.0", request, workspace: "/tmp/r", runDir: "/tmp/s", attachments: [], permissionPolicy: "native"});
  expect(launch.argv.at(-1)).toBe(request);
  expect(launch.cwd).toBe("/tmp/r");
});
