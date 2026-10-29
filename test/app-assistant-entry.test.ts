import { expect, test } from "bun:test";
import { assistantPreferences, setAssistantPreferences } from "../app/src/shell/assistant-entry";

test("assistant preferences tolerate blocked storage reads and writes", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem() { throw new Error("Storage blocked"); },
    setItem() { throw new Error("Storage blocked"); },
  } });
  try {
    expect(assistantPreferences()).toEqual({ showButton: true, stillAurora: false });
    expect(() => setAssistantPreferences({ showButton: false })).not.toThrow();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
