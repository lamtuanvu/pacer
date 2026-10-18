import { expect, spyOn, test } from "bun:test";
import { createApi } from "../app/src/data/api";

test("401 reports expiration to the desktop shell and still informs the browser caller", async () => {
  const host = globalThis as typeof globalThis & { __TAURI__?: { core: { invoke: (command: string) => Promise<void> } } };
  const previous = host.__TAURI__;
  const commands: string[] = [];
  host.__TAURI__ = { core: { invoke: async command => { commands.push(command); } } };
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));
  let ended = 0;
  try {
    await expect(createApi(() => ended++).hello()).rejects.toMatchObject({ status: 401 });
    expect(commands).toEqual(["session_expired"]);
    expect(ended).toBe(1);
    delete host.__TAURI__;
    await expect(createApi(() => ended++).snapshot()).rejects.toMatchObject({ status: 401 });
    expect(commands).toEqual(["session_expired"]);
    expect(ended).toBe(2);
  } finally {
    fetchSpy.mockRestore();
    if (previous) host.__TAURI__ = previous;
    else delete host.__TAURI__;
  }
});
