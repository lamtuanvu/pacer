import { expect, spyOn, test } from "bun:test";
import { createApi } from "../app/src/data/api";

test("401 reports expiration to the desktop shell and still informs the browser caller", async () => {
  const host = globalThis as typeof globalThis & { __TAURI__?: { core: { invoke: (command: string) => Promise<unknown> } } };
  const previous = host.__TAURI__;
  const commands: string[] = [];
  // Persistent workbench design §5.2: desktop uses Rust IPC; browsers retain HTTP.
  // docs/specs/2026-10-31-persistent-workbench-design.md
  host.__TAURI__ = { core: { invoke: async command => {
    commands.push(command);
    if (command === "service_hello") return { status: 401, body: [] };
    if (command === "session_expired") return;
    throw Error(`Unexpected desktop command: ${command}`);
  } } };
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));
  let ended = 0;
  try {
    await expect(createApi(() => ended++).hello()).rejects.toMatchObject({ status: 401 });
    expect(commands).toEqual(["service_hello", "session_expired"]);
    expect(ended).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    delete host.__TAURI__;
    await expect(createApi(() => ended++).snapshot()).rejects.toMatchObject({ status: 401 });
    expect(commands).toEqual(["service_hello", "session_expired"]);
    expect(ended).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  } finally {
    fetchSpy.mockRestore();
    if (previous) host.__TAURI__ = previous;
    else delete host.__TAURI__;
  }
});
