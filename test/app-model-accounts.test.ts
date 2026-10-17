import { expect, test } from "bun:test";
import { accountsModel } from "../app/src/model/accounts";
test("accounts retain all windows and use limits freshness and sign-in facts", () => {
  const rows = accountsModel([{ name: "team", kind: "codex", signedIn: false, signin_command: "codex login", usageReading: { windows: [{ name: "5h", usedPct: 20, resetsAt: 100 }, { name: "7d", usedPct: 40, resetsAt: 200 }] } }], [{ account: "team", stale: true, capturedAt: 50, source: "session-log" }]);
  expect(rows[0]!.windows).toHaveLength(2);
  expect(rows[0]!.freshness).toContain("Stale since");
  expect(rows[0]!.signin).toBe("codex login");
});
test("endpoint details contain only the public host and key presence", () => {
  const row = accountsModel([{ name: "local", kind: "endpoint", connection: { base_url_host: "localhost", key: "missing", models: [{ id: "m" }] } }], [])[0]!;
  expect(row.connection?.key).toBe("missing");
  expect(row.signin).toBeUndefined();
});

test("account windows keep today's meter colours until the settings rewrite", () => {
  const rows = accountsModel([{ name: "team", kind: "codex", usageReading: { windows: [{ name: "5h", usedPct: 97, resetsAt: 1 }, { name: "7d", usedPct: 40, resetsAt: 2 }] } }], []);
  expect(rows[0]!.windows.map(w => w.tone)).toEqual(["bad", "good"]);
});
