import { expect, test } from "bun:test";
import { startServer } from "../src/serve/http";
import { fakeCtx } from "./helpers";
import { createDraft } from "../src/attachments/store";
import { createSession } from "../src/serve/app-auth";

test("attachment streaming routes retain authentication and browser origin checks", async () => {
  const ctx = fakeCtx(), draft = createDraft(ctx), server = startServer(() => ctx, {port: 0, listener: false});
  const origin = `http://127.0.0.1:${server.port}`, url = `${origin}/v3/attachments?draft=${draft.id}&batch=one`;
  const headers = {Authorization: `Bearer ${server.token}`, "X-Pacer-Filename": "hello.txt", "Content-Type": "text/plain"};
  try {
    expect((await fetch(url, {method: "POST", body: "hello"})).status).toBe(401);
    const cookie = `pacer_session=${createSession(ctx)}`;
    expect((await fetch(url, {method: "POST", headers: {Cookie: cookie, Origin: "https://foreign.invalid", "X-Pacer-Client": "app"}, body: "hello"})).status).toBe(403);
    const response = await fetch(url, {method: "POST", headers, body: "hello"});
    expect(response.status).toBe(201);
    const {id} = await response.json() as {id: string};
    const read = await fetch(`${origin}/v3/attachments/${id}?draft=${draft.id}`, {headers});
    expect(await read.text()).toBe("hello");
    expect(read.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await fetch(`${origin}/v3/attachments/${id}?draft=foreign`, {headers})).status).toBe(404);
  } finally {server.stop();}
});
