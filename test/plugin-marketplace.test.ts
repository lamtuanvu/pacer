import { expect, test } from "bun:test";
import { z } from "zod";
import marketplace from "../orca-marketplace.json";
import pkg from "../package.json";
import { pluginManifest } from "../orca-plugin/src/manifest";

// Mirrors Orca's plugin-marketplace.ts rules; this listing additionally requires HTTPS .git URLs.
const slug = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .refine(id => !["__proto__", "prototype", "constructor"].includes(id));
const entry = z.strictObject({
  id: z.string().refine(id => id.split(".").length === 2 && id.split(".").every(part => slug.safeParse(part).success)),
  source: z.strictObject({
    kind: z.literal("git"),
    url: z.string().trim().min(1).max(32 * 1024).refine(value => {
      try { const url = new URL(value); return url.protocol === "https:" && url.pathname.endsWith(".git") && !url.username && !url.password; }
      catch { return false; }
    }),
    ref: z.string().trim().min(1).max(4096),
  }),
  description: z.string().min(1).max(4096).optional(),
  categories: z.array(z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)).max(16).default([]),
}).refine(plugin => new Set(plugin.categories).size === plugin.categories.length);
const schema = z.strictObject({
  name: z.string().min(1).max(256),
  owner: z.string().min(1).max(128).regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/),
  plugins: z.array(entry).max(2048),
}).refine(value => new Set(value.plugins.map(plugin => plugin.id)).size === value.plugins.length);

test("marketplace follows Orca rules and points to the versioned root plugin bundle", () => {
  const parsed = schema.parse(marketplace);
  const manifest = pluginManifest(pkg.version);
  expect(parsed.owner).toBe(manifest.publisher);
  expect(parsed.plugins).toHaveLength(1);
  expect(parsed.plugins[0]).toEqual({
    id: `${manifest.publisher}.${manifest.id}`,
    source: { kind: "git", url: "https://github.com/lamtuanvu/pacer.git", ref: `orca-plugin-v${pkg.version}` },
    description: manifest.description,
    categories: ["productivity"],
  });
  expect(manifest.repository).toBe("https://github.com/lamtuanvu/pacer");
});

test("marketplace rejects subdirectory sources, empty refs, invalid categories and duplicate ids", () => {
  for (const change of [
    { source: { ...marketplace.plugins[0].source, path: "orca-plugin/dist" } },
    { source: { ...marketplace.plugins[0].source, ref: " " } },
    { source: { ...marketplace.plugins[0].source, url: "http://github.com/lamtuanvu/pacer.git" } },
    { categories: ["Developer Tools"] },
    { categories: ["productivity", "productivity"] },
  ]) expect(schema.safeParse({ ...marketplace, plugins: [{ ...marketplace.plugins[0], ...change }] }).success).toBe(false);
  expect(schema.safeParse({ ...marketplace, plugins: [marketplace.plugins[0], marketplace.plugins[0]] }).success).toBe(false);
});
