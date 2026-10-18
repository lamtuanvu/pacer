import { expect, test } from "bun:test";
import { applyTheme, savedTheme, THEME_KEY } from "../app/src/theme";

test("saved appearance is read from device storage and defaults to system", () => {
  const store = (v: string | null) => ({ getItem: (k: string) => k === THEME_KEY ? v : null });
  expect(savedTheme(store("dark"))).toBe("dark");
  expect(savedTheme(store("light"))).toBe("light");
  expect(savedTheme(store("purple"))).toBe("system");
  expect(savedTheme(store(null))).toBe("system");
  expect(savedTheme({ getItem: () => { throw new Error("blocked"); } })).toBe("system");
});

test("applying a theme sets or clears data-theme so the tray and app follow Settings › Appearance", () => {
  const root = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
  applyTheme("dark", root); expect(root.dataset.theme).toBe("dark");
  applyTheme("system", root); expect(root.dataset.theme).toBeUndefined();
});

test("the tray entry and the app entry both follow the saved theme", async () => {
  for (const entry of ["app/src/tray/main.tsx", "app/src/main.tsx"]) expect(await Bun.file(entry).text()).toContain("followSavedTheme()");
});
