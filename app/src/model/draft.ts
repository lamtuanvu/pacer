type Fields<T> = { [K in keyof T]: string };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
/** Only allow known, non-secret form fields; tolerate disabled browser storage. */
export function draftStorage<T extends Fields<T>>(key: string, defaults: T, storage: Storage) {
  return {
    read(): T {
      try {
        const saved = JSON.parse(storage.getItem(key) ?? "null");
        return { ...defaults, ...Object.fromEntries(Object.keys(defaults).filter(k => typeof saved?.[k] === "string").map(k => [k, saved[k]])) };
      } catch { return defaults; }
    },
    write(value: T) { try { storage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } },
    clear() { try { storage.removeItem(key); } catch { /* storage unavailable */ } },
  };
}
