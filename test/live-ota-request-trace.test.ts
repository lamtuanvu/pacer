import { afterEach, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOtaRequestTrace, OTA_REQUEST_TRACE_LIMIT } from "../scripts/live/ota-request-trace";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ota-trace-")));
  roots.push(root);
  chmodSync(root, 0o700);
  mkdirSync(join(root, "evidence"), { mode: 0o700 });
  return { id: "trace", root, pid: process.pid, port: 49900, createdAt: "now" };
}
function file(root: string) { return join(root, "evidence/ota-request-trace.jsonl"); }
test("trace writes private fixed schema and one random diagnostic correlation", () => {
  const session = fixture(), trace = createOtaRequestTrace(session, "desktop.update.check");
  trace({ stage: "body", outcome: "start" });
  trace({ stage: "upstream", outcome: "response", status: 202 });
  const events = readFileSync(file(session.root), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(events).toHaveLength(2);
  expect(Object.keys(events[0]).sort()).toEqual(["correlationId", "elapsedMs", "op", "outcome", "stage"]);
  expect(events[0].correlationId).toMatch(/^[a-f0-9-]{36}$/);
  expect(events[0].correlationId).toBe(events[1].correlationId);
  expect(events[0].elapsedMs).toBeGreaterThanOrEqual(0);
  expect(events[1].status).toBe(202);
  expect(statSync(file(session.root)).mode & 0o777).toBe(0o600);
  expect(statSync(join(session.root, "evidence")).mode & 0o777).toBe(0o700);
});
test("trace discards arbitrary fields and refuses invalid fixed fields", () => {
  const session = fixture(), trace = createOtaRequestTrace(session, "desktop.update.restart");
  trace({ stage: "body", outcome: "error", token: "secret-token", requestId: "secret-request", error: "secret-error", path: "/secret-path" } as never);
  trace({ stage: "secret-stage", outcome: "error" } as never);
  trace({ stage: "body", outcome: "secret-outcome" } as never);
  trace({ stage: "upstream", outcome: "response", status: 999 });
  const content = readFileSync(file(session.root), "utf8");
  expect(content).not.toContain("secret");
  expect(content.trim().split("\n")).toHaveLength(1);
  expect(() => createOtaRequestTrace(session, "arbitrary" as never)({ stage: "body", outcome: "start" })).not.toThrow();
  expect(readFileSync(file(session.root), "utf8")).toBe(content);
});
test("unsafe evidence directories and destinations are left untouched", () => {
  for (const kind of ["file-symlink", "file-hardlink", "file-mode", "directory", "dir-symlink", "dir-mode", "root-mode", "root-symlink", "lock"] as const) {
    const session = fixture(), target = join(session.root, "target"), evidence = join(session.root, "evidence");
    writeFileSync(target, "private sentinel", { mode: 0o600 });
    if (kind === "file-symlink") symlinkSync(target, file(session.root));
    if (kind === "file-hardlink") linkSync(target, file(session.root));
    if (kind === "file-mode") {
      writeFileSync(file(session.root), "private sentinel", { mode: 0o600 });
      // Creation modes are filtered by umask; this case must really be unsafe.
      chmodSync(file(session.root), 0o644);
    }
    if (kind === "directory") mkdirSync(file(session.root), { mode: 0o700 });
    if (kind === "dir-symlink") { rmSync(evidence, { recursive: true }); mkdirSync(join(session.root, "other"), { mode: 0o700 }); symlinkSync(join(session.root, "other"), evidence); }
    if (kind === "dir-mode") chmodSync(evidence, 0o755);
    if (kind === "root-mode") chmodSync(session.root, 0o755);
    if (kind === "root-symlink") { symlinkSync(session.root, session.root + "-link"); roots.push(session.root + "-link"); session.root += "-link"; }
    if (kind === "lock") writeFileSync(join(evidence, ".ota-request-trace.lock"), "held", { mode: 0o600 });
    if (kind === "file-mode") expect(statSync(file(session.root)).mode & 0o7777).toBe(0o644);
    if (kind === "dir-mode") expect(statSync(evidence).mode & 0o7777).toBe(0o755);
    if (kind === "root-mode") expect(statSync(session.root).mode & 0o7777).toBe(0o755);
    expect(() => createOtaRequestTrace(session, "desktop.update.check")({ stage: "body", outcome: "start" })).not.toThrow();
    expect(readFileSync(target, "utf8")).toBe("private sentinel");
    if (kind === "file-mode") {
      expect(readFileSync(file(session.root), "utf8")).toBe("private sentinel");
      expect(statSync(file(session.root)).mode & 0o7777).toBe(0o644);
    }
    if (["dir-symlink", "dir-mode", "root-mode", "root-symlink", "lock"].includes(kind)) expect(() => statSync(file(session.root))).toThrow();
  }
});
test("trace cap refuses whole events without truncation or growth", () => {
  const session = fixture(), trace = createOtaRequestTrace(session, "desktop.update.check");
  writeFileSync(file(session.root), "x".repeat(OTA_REQUEST_TRACE_LIMIT - 1), { mode: 0o600 });
  trace({ stage: "body", outcome: "start" });
  expect(statSync(file(session.root)).size).toBe(OTA_REQUEST_TRACE_LIMIT - 1);
  writeFileSync(file(session.root), "x".repeat(OTA_REQUEST_TRACE_LIMIT + 1), { mode: 0o600 });
  trace({ stage: "body", outcome: "start" });
  expect(statSync(file(session.root)).size).toBe(OTA_REQUEST_TRACE_LIMIT + 1);
});
