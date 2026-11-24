#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { serve, stdinLines, workflowDefinitions, type PluginManifest } from "@pacer/plugin";

const manifest = JSON.parse(readFileSync("pacer-plugin.json", "utf8")) as PluginManifest;
const fixture = JSON.parse(readFileSync("fixture.json", "utf8")) as {
  workflowPages: Array<{ workflows: unknown[]; next?: string }>;
};
const pages = fixture.workflowPages.map((page) => ({
  ...page,
  workflows: page.workflows.map((entry) => {
    const item = entry as { name: string; version: number; source: string; prompts: Record<string, string> };
    return { ...item, source: item.source.replaceAll("__PLUGIN__", manifest.id) };
  }),
}));

await serve({
  manifest,
  input: stdinLines(),
  handlers: {
    "diagnostic.ping": async () => ({ ok: true, uptimeS: 0 }),
    ...workflowDefinitions((params) => {
      const after = params.after;
      let idx = 0;
      if (after !== undefined) {
        const prior = pages.findIndex((page) => page.next === after);
        idx = prior < 0 ? pages.length : prior + 1;
      }
      const page = pages[idx];
      if (!page) return { workflows: [] };
      return {
        workflows: page.workflows,
        ...(page.next ? { next: page.next } : {}),
      };
    }),
  },
});
