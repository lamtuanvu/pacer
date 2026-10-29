import { expect, test } from "bun:test";
import { readyControl } from "../scripts/live/ota-takeover";

const button = (disabled?: boolean) => ({ ref: "e1", role: "button", name: "Use the app's service", actions: ["click"], disabled });

test("the driver clicks a control only once it is enabled, so the confirm hold is waited out", () => {
  // aria-disabled during the hold reaches the inspector as a disabled control.
  expect(readyControl([button(true)], "Use the app's service")).toBeNull();
  expect(readyControl([button(false)], "Use the app's service")?.ref).toBe("e1");
  expect(readyControl([button()], "Use the app's service")?.ref).toBe("e1");
  // Headings and text with the same name are never clicked.
  expect(readyControl([{ ...button(), role: "heading" }, { ...button(), role: "static text" }], "Use the app's service")).toBeNull();
  expect(readyControl([button()], "Not now")).toBeNull();
});
