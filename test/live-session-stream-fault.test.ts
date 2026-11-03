import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { armSessionStreamFault, boundedPluginLines, SessionStreamFaultFilter } from "../scripts/live/session-stream-fault";
import { tmpDir } from "./helpers";

const taskId = "t-20261027-040000-abcd";
const streamId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const token = "owned-stream-token";
const stream = JSON.stringify({ id: 5, method: "hostRunner.stream", params: {
  script: "SESSION_PIPE", args: [`/remote/.pacer-remote/runs/${taskId}/1`], streamId },
  _meta: { capabilityCall: token } });
const input = JSON.stringify({ method: "$/streamInput", params: { request: 5, streamId, seq: 0, base64: "eA==" } });
const write = JSON.stringify({ id: 17, method: "capability.process.duplex.write",
  params: { handle: "opaque", base64: "eA==" }, _meta: { capabilityCall: token } });
const ack = JSON.stringify({ id: 19, method: "$/streamInputAck",
  params: { request: 5, streamId, seq: 0 }, _meta: { capabilityCall: token } });

test("live stream fault filter passes frames unchanged when unarmed", () => {
  const filter = new SessionStreamFaultFilter(tmpDir());
  for (const [direction, line] of [["host-to-plugin", stream], ["host-to-plugin", input],
    ["plugin-to-host", write], ["plugin-to-host", ack]] as const)
    expect(filter.line(direction, line)).toBe(line);
});

test("lost ACK fault is one use only after the exact broker write receipt", () => {
  const root = tmpDir(), armed = armSessionStreamFault(root, "lost-input-ack");
  expect(statSync(join(root, "faults", "session-stream.json")).mode & 0o777).toBe(0o600);
  const filter = new SessionStreamFaultFilter(root), other = new SessionStreamFaultFilter(root);
  expect(filter.line("host-to-plugin", stream)).toBe(stream);
  expect(other.line("host-to-plugin", stream)).toBe(stream);
  expect(filter.line("host-to-plugin", input)).toBe(input);
  expect(filter.line("plugin-to-host", ack)).toBe(ack); // No write receipt yet.
  expect(filter.line("plugin-to-host", write)).toBe(write);
  expect(filter.line("host-to-plugin", JSON.stringify({ id: 17, error: { code: -1 } }))).not.toBeNull();
  expect(filter.line("plugin-to-host", ack)).toBe(ack);
  expect(filter.line("host-to-plugin", JSON.stringify({ id: 17, result: { bytes: 1 } }))).not.toBeNull();
  expect(filter.line("plugin-to-host", JSON.stringify({ ...JSON.parse(ack), _meta: { capabilityCall: "wrong" } }))).toBeTruthy();
  expect(filter.line("plugin-to-host", ack)).toBeNull();
  expect(filter.line("plugin-to-host", ack)).toBe(ack);
  const proof = JSON.parse(readFileSync(join(root, "faults", `${armed.id}.consumed.json`), "utf8"));
  expect(proof).toMatchObject({ mode: "lost-input-ack", taskId, streamId });
  expect(() => armSessionStreamFault(root, "read-response-timeout")).not.toThrow();
});

test("read timeout fault drops one exact owned duplex read response", () => {
  const root = tmpDir(), armed = armSessionStreamFault(root, "read-response-timeout");
  const filter = new SessionStreamFaultFilter(root);
  filter.line("host-to-plugin", stream);
  const read = JSON.stringify({ id: "r1", method: "capability.process.duplex.read",
    params: { handle: "opaque", length: 65536 }, _meta: { capabilityCall: token } });
  expect(filter.line("plugin-to-host", read)).toBe(read);
  const response = JSON.stringify({ id: "r1", result: { base64: "", eof: false } });
  expect(filter.line("host-to-plugin", response)).toBeNull();
  expect(filter.line("host-to-plugin", response)).toBe(response);
  expect(existsSync(join(root, "faults", `${armed.id}.consumed.json`))).toBe(true);
});

test("fault instruction refuses a substituted symlink", () => {
  const root = tmpDir();
  armSessionStreamFault(root, "lost-input-ack");
  const path = join(root, "faults", "session-stream.json");
  const target = join(root, "other.json");
  writeFileSync(target, JSON.stringify({ id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", mode: "lost-input-ack" }));
  rmSync(path);
  symlinkSync(target, path);
  expect(() => new SessionStreamFaultFilter(root).line("host-to-plugin", stream)).toThrow();
});

test("live proxy rejects an overlong line before retaining another chunk", async () => {
  const input = Readable.from([Buffer.alloc(1024 * 1024, 0x61), Buffer.from("b\n")]);
  const lines = boundedPluginLines(input);
  await expect(lines.next()).rejects.toThrow("protocol bound");
});

test("live proxy preserves split bounded JSON lines", async () => {
  const chunks = [Buffer.from('{"id":1,"text":"'), Buffer.from("fox 🦊"), Buffer.from('"}\n{"id":2}\n')];
  const lines: string[] = [];
  for await (const line of boundedPluginLines(Readable.from(chunks))) lines.push(line);
  expect(lines).toEqual(['{"id":1,"text":"fox 🦊"}', '{"id":2}']);
});
