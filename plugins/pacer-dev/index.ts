import { serve, workflowDefinitions, type Handler } from "@pacer/plugin";
import { manifest } from "./manifest";

export { manifest } from "./manifest";

/** Embedded at compile time (`bun build --compile`); never read from disk at runtime. */
import orchestratorMd from "./prompts/orchestrator.md" with { type: "text" };
import questionsMd from "./prompts/questions.md" with { type: "text" };
import dataMarkersMd from "./prompts/data-markers.md" with { type: "text" };
import brainstormMd from "./prompts/brainstorm.md" with { type: "text" };
import reviewMd from "./prompts/review.md" with { type: "text" };
import implementMd from "./prompts/implement.md" with { type: "text" };
import codeReviewMd from "./prompts/code-review.md" with { type: "text" };
import testMd from "./prompts/test.md" with { type: "text" };
import openPrMd from "./prompts/open-pr.md" with { type: "text" };
import planMd from "./prompts/plan.md" with { type: "text" };
import investigateMd from "./prompts/investigate.md" with { type: "text" };
import bugfixMd from "./prompts/bugfix.md" with { type: "text" };
import askMd from "./prompts/ask.md" with { type: "text" };
import routerYaml from "./workflows/router.yaml" with { type: "text" };
import featureYaml from "./workflows/feature.yaml" with { type: "text" };
import featureV2Yaml from "./workflows/feature-v2.yaml" with { type: "text" };
import bugYaml from "./workflows/bug.yaml" with { type: "text" };
import askYaml from "./workflows/ask.yaml" with { type: "text" };

const SHARED_PROMPTS: Record<string, string> = {
  "prompts/orchestrator.md": orchestratorMd,
  "prompts/questions.md": questionsMd,
  "prompts/data-markers.md": dataMarkersMd,
};

/** Prepend plugin-level shared rules into every command-capable agent step prompt. */
const REAL_INSTALL_RULE = `## Real-install rule (hard)

Never touch the person's real pacer install: \`/Applications/pacer.app\`, \`~/.local/bin/pacer*\`, \`~/.pacer\`, or \`com.pacer.serve\`. Use only a temporary \`PACER_HOME\`/\`HOME\` sandbox harness.
`;

function agentPrompt(body: string): string {
  return `${dataMarkersMd}\n\n${questionsMd}\n\n${REAL_INSTALL_RULE}\n\n${body}`;
}

const FEATURE_PROMPTS: Record<string, string> = {
  ...SHARED_PROMPTS,
  "prompts/brainstorm.md": agentPrompt(brainstormMd),
  "prompts/review.md": agentPrompt(reviewMd),
  "prompts/implement.md": agentPrompt(implementMd),
  "prompts/code-review.md": agentPrompt(codeReviewMd),
  "prompts/test.md": agentPrompt(testMd),
  "prompts/open-pr.md": agentPrompt(openPrMd),
};

const FEATURE_V2_PROMPTS: Record<string, string> = {
  ...SHARED_PROMPTS,
  "prompts/brainstorm.md": agentPrompt(brainstormMd),
  "prompts/review.md": agentPrompt(reviewMd),
  "prompts/plan.md": agentPrompt(planMd),
  "prompts/open-pr.md": agentPrompt(openPrMd),
};

const BUG_PROMPTS: Record<string, string> = {
  ...SHARED_PROMPTS,
  "prompts/investigate.md": agentPrompt(investigateMd),
  "prompts/bugfix.md": agentPrompt(bugfixMd),
  "prompts/test.md": agentPrompt(testMd),
  "prompts/open-pr.md": agentPrompt(openPrMd),
};

const ASK_PROMPTS: Record<string, string> = {
  ...SHARED_PROMPTS,
  "prompts/ask.md": agentPrompt(askMd),
};

type Page = {
  name: string;
  version: number;
  source: string;
  prompts: Record<string, string>;
};

/** Stable page order; one workflow per reply. `next` is the following page's `name@version`. */
const PAGES: Page[] = [
  { name: "router", version: 1, source: routerYaml, prompts: { ...SHARED_PROMPTS } },
  { name: "feature", version: 1, source: featureYaml, prompts: FEATURE_PROMPTS },
  { name: "feature", version: 2, source: featureV2Yaml, prompts: FEATURE_V2_PROMPTS },
  { name: "bug", version: 1, source: bugYaml, prompts: BUG_PROMPTS },
  { name: "ask", version: 1, source: askYaml, prompts: ASK_PROMPTS },
];

function pageKey(page: Page): string {
  return `${page.name}@${page.version}`;
}

/** Host passes the previous page's `next` (the next page's key) as `after`. */
function resolvePage(after: string | undefined): { page: Page; next?: string } | undefined {
  const idx = after === undefined || after === ""
    ? 0
    : PAGES.findIndex(p => pageKey(p) === after);
  if (idx < 0 || idx >= PAGES.length) return undefined;
  const page = PAGES[idx]!;
  const following = PAGES[idx + 1];
  return { page, ...(following ? { next: pageKey(following) } : {}) };
}

export const handlers = {
  "diagnostic.ping": async () => ({ ok: true, uptimeS: 0 }),
  ...workflowDefinitions((params) => {
    const resolved = resolvePage(params.after);
    if (!resolved) return { workflows: [] };
    const { page, next } = resolved;
    return {
      workflows: [{ name: page.name, version: page.version, source: page.source, prompts: page.prompts }],
      ...(next ? { next } : {}),
    };
  }),
} satisfies Record<string, Handler>;

if (import.meta.main) await serve({ manifest, handlers });
