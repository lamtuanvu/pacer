import {expect, test} from "bun:test";
import {spendCopy} from "../src/view-model/copy";

test("weekly dollar spend reads the same everywhere, with the cap when there is one", () => {
  expect(spendCopy(null, null)).toBeNull();
  expect(spendCopy(3.2, null)).toBe("$3.20 this week");
  expect(spendCopy(0.0034, 5)).toBe("$0.00 of $5 this week");
  expect(spendCopy(3.2, 5)).toBe("$3.20 of $5 this week");
  expect(spendCopy(5.4, 5)).toBe("$5.40 of $5 this week · cap reached");
});
