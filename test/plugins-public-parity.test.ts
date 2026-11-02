import { expect, test } from "bun:test";
import { inspectArchive, verifyPublishedArchive } from "../src/plugins/archive";
import { validateSettings } from "../src/plugins/settings";
import { parseStatusItemDocument, parseViewDocument, type SettingsSchema } from "../src/plugins/ui-schema";
import publicCases from "./fixtures/plugin-public-parity.json";
import archiveCases from "./fixtures/plugin-archive-parity.json";

test("native plugin settings and document corpus still matches the TypeScript reference", () => {
  for (const item of publicCases.settings) expect(validateSettings(item.schema as SettingsSchema, item.values)).toEqual(item.errors);
  for (const item of publicCases.documents) expect((item.status ? parseStatusItemDocument : parseViewDocument)(item.raw) as unknown).toEqual(item.result);
});

test("native plugin archive corpus still matches the TypeScript reference", () => {
  for (const item of archiveCases.entries) {
    let error: string | null = null;
    try { inspectArchive(Buffer.from(item.base64, "base64")); }
    catch (e) { error = (e as Error).message; }
    expect(error).toBe(item.error);
  }
});

test("native signature encoding corpus matches the TypeScript reference", async () => {
  for (const row of archiveCases.signatures) {
    let error: string | null = null;
    try { await verifyPublishedArchive({} as any, inspectArchive(Buffer.from(archiveCases.entries[0].base64, "base64")), row.signature, { lookup: () => ({ key: archiveCases.publicKey }) as any }); }
    catch (e) { error = (e as Error).message; }
    expect(error).toBe(row.error);
  }
});
