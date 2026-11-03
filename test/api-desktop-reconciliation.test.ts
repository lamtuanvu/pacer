import { expect, test } from "bun:test";
import { callOp } from "../src/api/ops";
import { callV2Op, v2Hello } from "../src/api/v2-compat";
import { helloBody } from "../src/api/protocol";
import { fakeCtx } from "./helpers";

const request = { candidateId: "opaque", expectRevision: 0, requestId: "request" };
test("reconciliation is advertised only to current peers and reports bounded unavailable status", async () => {
  expect(helloBody().ops).toContain("desktop.reconcile.status");
  expect(v2Hello().ops).not.toContain("desktop.reconcile.status");
  expect(await callOp(fakeCtx(), "desktop.reconcile.status", {})).toEqual({ status: "unknown", reason: "peer-data-unavailable", capability: "unavailable", revision: 0 });
  await expect(callV2Op(fakeCtx(), "desktop.reconcile.status", {})).rejects.toMatchObject({ code: "unknown_op" });
});
test("requests and cancellation fail closed and reject authority fields", async () => {
  for (const name of ["desktop.reconcile.request", "desktop.reconcile.cancel"]) {
    await expect(callOp(fakeCtx(), name, request)).rejects.toMatchObject({ code: "unavailable" });
    await expect(callOp(fakeCtx(), name, { ...request, executable: "/private/secret" })).rejects.toMatchObject({ code: "invalid_input" });
  }
});

test("HTTP requires authentication and enforces origin and client for cookie writes", async () => {
  const { startServer } = await import("../src/serve/http");
  const { createCode } = await import("../src/serve/app-auth");
  const ctx = fakeCtx();
  const server = startServer(() => ctx, { port: 0, pumpMs: 0 });
  const origin = `http://127.0.0.1:${server.port}`;
  const post = (name: string, headers: Record<string, string>, body: unknown) => fetch(`${origin}/v3/ops/${name}`, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    expect((await fetch(`${origin}/v3/hello`)).status).toBe(401);
    const hello = await fetch(`${origin}/v3/hello`, { headers: { authorization: `Bearer ${server.token}` } });
    expect((await hello.json()).coreBuild).toEqual(helloBody().coreBuild);
    expect((await post("desktop.reconcile.status", {}, {})).status).toBe(401);
    expect((await post("desktop.reconcile.status", { authorization: `Bearer ${server.token}` }, {})).status).toBe(200);
    const auth = await fetch(`${origin}/app/auth?code=${createCode(ctx)}`);
    const cookie = auth.headers.get("set-cookie")!.split(";")[0];
    expect((await post("desktop.reconcile.request", { cookie }, request)).status).toBe(403);
    expect((await post("desktop.reconcile.request", { cookie, origin, "x-pacer-client": "app" }, request)).status).toBe(503);
  } finally { await server.stop(); }
});

test("assessment fails closed for absent or unsupported peer data and classifies bounded observations", async () => {
  const { assessReconciliation } = await import("../src/update/desktop/reconciliation-assessment");
  expect(assessReconciliation(undefined).reason).toBe("peer-data-unavailable");
  expect(assessReconciliation({ protocolMajor: 99 }).reason).toBe("unsupported-protocol");
  const base = { protocolMajor: 3, ownership: "managed", platform: "supported", compatibility: "compatible", capabilities: "missing", identity: "unverified" } as const;
  expect(assessReconciliation({ ...base, extra: "ignored" }).reason).toBe("missing-capability");
  expect(assessReconciliation({ ...base, ownership: "external" }).status).toBe("external");
  expect(assessReconciliation({ ...base, platform: "unavailable" }).reason).toBe("platform-unavailable");
  expect(assessReconciliation({ ...base, compatibility: "newer" }).status).toBe("incompatible");
  expect(assessReconciliation({ ...base, capabilities: "present", identity: "mismatch" }).status).toBe("mismatch");
  expect(assessReconciliation({ ...base, capabilities: "present", identity: "match" }).status).toBe("unverified");
});

test("hello exposes the bounded running core descriptor", async () => {
  const { coreBuildDescriptor } = await import("../src/update/desktop/build-identity");
  expect(helloBody().coreBuild).toEqual(coreBuildDescriptor());
  expect(helloBody().coreBuild.role).toBe("core");
});
