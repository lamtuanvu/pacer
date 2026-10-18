import { expect, test } from "bun:test";
import { openDesktop, screenRoute } from "../src/commands/open";
import { fakeCtx } from "./helpers";

test("CLI screen names target the same mounted routes in browser and desktop", async () => {
  for (const [screen, route] of Object.entries({ overview: "/", setup: "/", tasks: "/sessions", "tasks/t-1": "/sessions/t-1", executors: "/settings/executors", "executors/add": "/settings/add-executor", accounts: "/settings/accounts", hosts: "/settings/hosts", strategy: "/settings/strategies", "review/t-1": "/review/t-1", "sessions/t-1": "/sessions/t-1", "settings/hosts/box": "/settings/hosts/box" })) {
    expect(screenRoute(screen)).toBe(route);
    const calls: string[][] = [];
    const ctx = fakeCtx({run: async argv => { calls.push(argv); return {code:0,stdout:"",stderr:""}; }});
    expect(await openDesktop(ctx, screen, "darwin")).toBe(true);
    expect(calls[0]?.at(-1)).toBe(`pacer://${route === "/" ? "overview" : route.slice(1)}`);
  }
});
