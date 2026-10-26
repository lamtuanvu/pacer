import { expect, test } from "bun:test";

import * as model from "../app/src/screens/terminal/request";

test("a retried shell launch reuses its request ID until the folder changes", () => {
  let next = 0;
  const generate = () => `request-${++next}`;
  const first = model.terminalRequest(null, "/repo", generate);
  expect(model.terminalRequest(first, "/repo", generate)).toEqual(first);
  expect(model.terminalRequest(first, "/other", generate)).toEqual({ id: "request-2", cwd: "/other" });
  expect(model.pendingAfterFailure(first)).toEqual(first);
  expect(model.pendingAfterFailure(first,403)).toBeNull();
  expect(model.pendingAfterFailure(first,409)).toBeNull();
  expect(model.pendingAfterFailure(first,503)).toEqual(first);
});
