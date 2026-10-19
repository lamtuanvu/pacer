import { expect, test } from "bun:test";
import { join } from "node:path";
import * as time from "../src/view-model/time";
import * as format from "../src/view-model/format";

test("time helpers preserve the format compatibility exports", () => {
  for (const name of ["duration", "backIn", "ago", "elapsed", "clock"] as const) {
    expect(format[name]).toBe(time[name]);
  }
  expect(time.duration(90000)).toBe("1d 1h");
  expect(time.duration(90000, true)).toBe("1 day 1 hour");
  expect(time.duration(-60)).toBe("0m");
  expect(time.backIn(null, 100)).toBe("reset unknown");
  expect(time.backIn(3700, 100)).toBe("back in 1h 0m");
  expect(time.ago(100, 99)).toBe("0s ago");
  expect(time.elapsed(3900)).toBe("1h 05m");
});

test("browser time, copy and words imports stay within the lightweight vocabulary", async () => {
  const loaded = new Set<string>();
  const result = await Bun.build({
    entrypoints: ["time-vocabulary"], target: "browser", minify: true,
    plugins: [{ name: "time-vocabulary-boundary", setup(build) {
      build.onResolve({ filter: /^time-vocabulary$/ }, () => ({ path: "entry", namespace: "time-vocabulary" }));
      build.onLoad({ filter: /.*/, namespace: "time-vocabulary" }, () => ({
        loader: "ts", resolveDir: join(import.meta.dir, ".."),
        contents: 'export * from "./src/view-model/time"; export * from "./src/view-model/copy"; export * from "./src/view-model/words";',
      }));
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/, namespace: "file" }, args => {
        loaded.add(args.path.replaceAll("\\", "/").split("/src/")[1]!);
        return undefined;
      });
    } }],
  });
  expect(result.success).toBe(true);
  expect([...loaded].sort()).toEqual([
    "view-model/agents.ts", "view-model/copy.ts", "view-model/time.ts", "view-model/words.ts",
  ]);
});
