import { expect, test } from "bun:test";
import { capabilities, prepare, attachment, delegationControl } from "../plugins/agent-session/index";

test("delegation adapters describe native blocking paths without certifying them",()=>{
  expect(delegationControl({agent:"claude-code",version:"2.1.281"})).toMatchObject({mechanism:"hook",entryPoints:["Agent","Task"]});
  expect(delegationControl({agent:"codex",version:"0.164.0"})).toMatchObject({mechanism:"hook",entryPoints:["spawn_agent"]});
  expect(delegationControl({agent:"cursor",version:"2026.01.28"})).toMatchObject({mechanism:"hook",entryPoints:["subagentStart"]});
  expect(delegationControl({agent:"opencode",version:"2.1.2"})).toMatchObject({mechanism:"permission",entryPoints:["subagent"],permissionAction:"subagent"});
  expect(delegationControl({agent:"unknown",version:"1"})).toMatchObject({mechanism:"unsupported"});
});

const base = {request: '--dangerous $(echo hi)\n日本語', workspace: "/tmp/repo", runDir: "/tmp/run", attachments: [], permissionPolicy: "native" as const};
const image = {id: "image", name: "screen.png", mime: "image/png", size: 1, path: "/tmp/files/image with spaces"};
const identity = "01a15fa2-5a28-7bb0-9b62-6a4434975b55";

for (const [agent, version] of [["codex", "0.164.0"], ["codex", "0.165.1"], ["claude-code", "2.1.281"], ["opencode", "2.1.2"]]) {
  test(`${agent} ${version} offers implemented capabilities without an exact version lock`, () => {
    expect(capabilities({agent, version})).toMatchObject({interactive: true, resume: true, files: true, liveImages: false, launchImages: agent === "codex"});
  });
  test(`${agent} resume uses only the stored identity, without prompt or attachments`, () => {
    const launch = prepare({...base, agent, version, sessionId: identity, attachments: [image]});
    expect(launch.argv).toContain(identity);
    expect(launch.argv).not.toContain(base.request);
    expect(launch.argv).not.toContain(image.path);
    expect(launch.argv).not.toContain("--prompt");
    expect(launch.argv).not.toContain("--session-id");
  });
}
test("Codex delivers initial images natively with ordinary permissions and literal arguments", () => {
  const launch = prepare({...base, agent: "codex", version: "0.164.0", attachments: [image], model: "chosen"});
  expect(launch.argv).toEqual(["codex", "--no-daemon", "-C", "/tmp/repo", "-s", "workspace-write", "--add-dir", "/tmp/run", "-m", "chosen", "-i", image.path, "--", base.request]);
});
test("Claude starts with an assigned native UUID and explicitly referenced files", () => {
  const launch = prepare({...base, agent: "claude-code", version: "2.1.281", newSessionId: identity, model: "sonnet", attachmentDir: "/tmp/files", attachments: [image]});
  expect(launch.argv.slice(0, 9)).toEqual(["claude", "--add-dir", "/tmp/run", "--add-dir", "/tmp/files", "--model", "sonnet", "--session-id", identity]);
  expect(launch.argv.at(-2)).toBe("--");
  expect(launch.argv.at(-1)).toContain(base.request);
  expect(launch.argv.at(-1)).toContain(JSON.stringify(image.path));
  expect(launch.argv).not.toContain("--dangerously-skip-permissions");
});
test("OpenCode uses a private server and explicit identity without unsupported TUI model flags", () => {
  const launch = prepare({...base, agent: "opencode", version: "2.1.2", newSessionId: "ses_native", model: "provider/model", attachments: [image]});
  expect(launch.argv.slice(0, 5)).toEqual(["opencode", "--standalone", "--session", "ses_native", "--prompt"]);
  expect(launch.argv.at(-1)).toContain(JSON.stringify(image.path));
  expect(launch.argv).not.toContain("-m");
  expect(launch.argv).not.toContain("--auto");
  expect(launch.cwd).toBe(base.workspace);
});
test("unsupported agents report their actual agent name", () => {
  expect(capabilities({agent: "cursor", version: "1.0.0"})).toMatchObject({interactive: false, reason: expect.stringContaining("cursor")});
  expect(() => prepare({...base, agent: "cursor", version: "1.0.0"})).toThrow("cursor");
});
test("interface probes reject missing required mechanisms rather than the version number", () => {
  expect(capabilities({agent: "claude-code", version: "unknown", help: "--session-id --resume --add-dir --model --settings"})).toMatchObject({interactive: true});
  expect(capabilities({agent: "claude-code", version: "2.1.281", help: "--session-id --add-dir --model --settings"})).toMatchObject({interactive: false, reason: expect.stringContaining("--resume")});
  expect(capabilities({agent: "codex", version: "0.164.0", help: ""})).toMatchObject({interactive: false});
});
test("optional no-daemon is omitted when not advertised", () => {
  const help = "--config --cd --sandbox --add-dir --model --image --dangerously-bypass-hook-trust";
  const launch = prepare({...base, agent: "codex", version: "0.200.0", help, resumeHelp: help});
  expect(launch.argv).not.toContain("--no-daemon");
});
for (const agent of ["codex", "claude-code", "opencode"]) {
  test(`${agent} later attachment is an explicit reference without input submission`, () => {
    expect(attachment({agent, version: "1.0.0", workspace: base.workspace, phase: "live", attachment: image})).toEqual({kind: "reference", text: `Use the attached file "screen.png" at ${JSON.stringify(image.path)}.`, requiresUserSubmit: true});
  });
}

test("identity mechanisms belong to the adapter and never select the latest session", async () => {
  const {identity} = await import('../plugins/agent-session');
  expect(identity({agent:'claude-code',version:'2.1.281',taskId:'task'})).toMatchObject({kind:'assigned',id:expect.stringMatching(/^[a-f0-9-]{36}$/)});
  expect(identity({agent:'opencode',version:'2.1.2',taskId:'task'})).toEqual({kind:'command',argv:['opencode','api','--standalone','session.create','--data','{"title":"pacer task","agent":"build"}'],idPath:['data','id']});
  expect(identity({agent:'opencode',version:'2.1.2',taskId:'task',sessionId:'ses_exact'})).toMatchObject({kind:'command',argv:['opencode','api','--standalone','session.get','--param','sessionID=ses_exact'],idPath:['data','id']});
});
