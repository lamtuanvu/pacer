import { expect, test } from "bun:test";
import { httpStatus, rpcError, toApiError } from "../src/api/protocol";
import { CoreError } from "../src/core/errors";
import { renderProtocolDoc } from "../scripts/protocol-doc";

test("plugin error codes map to HTTP statuses and JSON-RPC -32000", () => {
  expect([
    httpStatus("plugin_timeout"),
    httpStatus("plugin_unavailable"),
    httpStatus("plugin_refused"),
    httpStatus("capability_denied"),
    httpStatus("unknown_plugin"),
  ]).toEqual([504, 503, 422, 403, 404]);
  const e = new CoreError("plugin_timeout", "diagnostic.ping passed its 5000 ms deadline");
  expect(toApiError(e)).toEqual({ code: "plugin_timeout", message: "diagnostic.ping passed its 5000 ms deadline" });
  expect(rpcError(e)).toMatchObject({ code: -32000, data: { code: "plugin_timeout" } });
});

test("the client protocol doc lists the plugin error codes", () => {
  const doc = renderProtocolDoc();
  for (const code of ["plugin_timeout", "plugin_unavailable", "plugin_refused", "capability_denied", "unknown_plugin"]) {
    expect(doc).toContain(`| \`${code}\` |`);
  }
});
