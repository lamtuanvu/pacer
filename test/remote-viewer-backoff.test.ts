import { expect, test } from "bun:test";
import { emptyViewerPollDelay } from "../src/remote/viewer";

test("empty PTY polls back off to two seconds and reset after data", () => {
  let emptyReads = 0;
  const empty = () => emptyViewerPollDelay(++emptyReads);
  const data = () => { emptyReads = 0; };
  expect([empty(), empty(), empty(), empty(), empty()]).toEqual([200, 400, 800, 1600, 2000]);
  expect(empty()).toBe(2000);
  data();
  expect(empty()).toBe(200);
});
