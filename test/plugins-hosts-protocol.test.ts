import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHosts } from "../packages/plugin-sdk/src/hosts";
import type { HostRunnerRunInput } from "../packages/plugin-sdk/src/host-runner";
import { CAPABILITY_METHODS, capabilityOf, manifestSchema } from "../src/plugins/protocol";
import { HOSTS_METHODS } from "../src/plugins/hosts-protocol";

const session = "opaque_session_1234567890";
const request: HostRunnerRunInput = { session, script: "PROBE", args: [], timeoutMs: 1000, maxBytes: 1024 };

test("hosts methods use one declared capability and bounded fixed-script envelopes", () => {
  expect(Object.keys(HOSTS_METHODS).sort()).toEqual([
    "capability.hosts.claimOwned", "capability.hosts.close", "capability.hosts.fetch",
    "capability.hosts.open", "capability.hosts.pollOwned", "capability.hosts.prepareOwned",
    "capability.hosts.readOwnedOutput", "capability.hosts.run", "capability.hosts.startOwned",
    "capability.hosts.stopOwned", "capability.hosts.transferOwned",
  ]);
  expect(manifestSchema.safeParse({
    id: "fx-host-client", version: "1.0.0", publisher: "test", host: "^1.5",
    capabilities: [{ name: "hosts" }],
  }).success).toBe(true);
  for (const method of Object.keys(HOSTS_METHODS)) {
    expect(CAPABILITY_METHODS[method]).toBeDefined();
    expect(capabilityOf(method)).toBe("hosts");
    expect(HOSTS_METHODS[method as keyof typeof HOSTS_METHODS].deadlineMs).toBeGreaterThan(0);
  }
  expect(HOSTS_METHODS["capability.hosts.open"].params.safeParse({ alias: "box" }).success).toBe(true);
  expect(HOSTS_METHODS["capability.hosts.open"].params.safeParse({ alias: "box", sshTarget: "user@host" }).success).toBe(false);
  expect(HOSTS_METHODS["capability.hosts.open"].params.safeParse({ alias: "box", provider: "evil" }).success).toBe(false);
  expect(HOSTS_METHODS["capability.hosts.run"].params.safeParse(request).success).toBe(true);
  expect(HOSTS_METHODS["capability.hosts.run"].params.safeParse({ ...request, script: "bash -lc 'id'" }).success).toBe(false);
  expect(HOSTS_METHODS["capability.hosts.run"].params.safeParse({ ...request, maxBytes: 524289 }).success).toBe(false);
  expect(HOSTS_METHODS["capability.hosts.run"].params.safeParse({ ...request, timeoutMs: Infinity }).success).toBe(false);
  expect(HOSTS_METHODS["capability.hosts.run"].params.safeParse({ ...request, target: "other" }).success).toBe(false);
  expect(HOSTS_METHODS["capability.hosts.run"].params.safeParse({ ...request,
    completionNonce: "123e4567-e89b-42d3-a456-426614174000" }).success).toBe(false);
  expect(HOSTS_METHODS["capability.hosts.fetch"].params.safeParse({ session, timeoutMs: 1000, maxBytes: 16 }).success).toBe(true);
  expect(HOSTS_METHODS["capability.hosts.fetch"].params.safeParse({ session, timeoutMs: 1000, maxBytes: 16,
    taskId: "forged" }).success).toBe(false);
  expect(HOSTS_METHODS["capability.hosts.close"].params.safeParse({ session, alias: "other" }).success).toBe(false);
  expect(HOSTS_METHODS["capability.hosts.open"].result.safeParse({ session }).success).toBe(true);
  expect(HOSTS_METHODS["capability.hosts.open"].result.safeParse({ session: "short" }).success).toBe(false);
  expect(HOSTS_METHODS["capability.hosts.transferOwned"].params.safeParse({ taskId: "t-fixture", attempt: 1 }).success).toBe(true);
  expect(HOSTS_METHODS["capability.hosts.transferOwned"].params.safeParse({ taskId: "t-fixture", attempt: 1,
    sshTarget: "user@host" }).success).toBe(false);
});

test("published schema names every hosts method and rejects caller-selected targets", () => {
  const schema = JSON.parse(readFileSync(join(import.meta.dir, "..", "docs", "plugin-protocol.schema.json"), "utf8"));
  expect(schema.$defs.manifest.properties.capabilities.items.properties.name.enum).toContain("hosts");
  expect(schema.$defs["capability.hosts.open.params"].properties.alias.pattern).toBeDefined();
  expect(schema.$defs["capability.hosts.open.params"].additionalProperties).toBe(false);
  expect(schema.$defs["capability.hosts.run.params"].properties.script.enum).toContain("PROBE");
  expect(schema.$defs["capability.hosts.run.params"].additionalProperties).toBe(false);
  expect(schema.$defs["capability.hosts.run.params"].properties.completionNonce).toBeUndefined();
  expect(schema.$defs["capability.hosts.fetch.params"].additionalProperties).toBe(false);
});

test("SDK hosts client sends only the four bounded method names", async () => {
  const sent: { method: string; params: unknown }[] = [];
  const hosts = createHosts(async <T>(method: string, params: unknown): Promise<T> => {
    sent.push({ method, params });
    if (method === "capability.hosts.open") return { session } as T;
    if (method === "capability.hosts.run") return { code: 0, stdout: "", stderr: "", timedOut: false } as T;
    return { ok: true } as T;
  });
  expect(await hosts.open("box")).toEqual({ session });
  expect(await hosts.run(request)).toMatchObject({ code: 0 });
  expect(await hosts.fetch({ session, timeoutMs: 1000, maxBytes: 16 })).toEqual({ ok: true });
  expect(await hosts.close(session)).toEqual({ ok: true });
  expect(sent).toEqual([
    { method: "capability.hosts.open", params: { alias: "box" } },
    { method: "capability.hosts.run", params: request },
    { method: "capability.hosts.fetch", params: { session, timeoutMs: 1000, maxBytes: 16 } },
    { method: "capability.hosts.close", params: { session } },
  ]);
});
