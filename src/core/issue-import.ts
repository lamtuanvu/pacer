import { z } from "zod";
import { repoKey } from "../config/hosts";
import { isExecutorSession } from "../install/role";
import { boundedGitRead } from "./git";
import { listRepos } from "./repos";
import { CoreError, type CoreErrorCode } from "./errors";
import type { RepoRef } from "../api/read-model/types";
import type { Ctx, RunResult } from "../types";

/**
 * Read-only GitHub issue import for the New task composer. The repository must be registered with pacer;
 * its GitHub identity comes from the checkout's `origin` remote, never from the request. Issue content is
 * untrusted: it is returned as capped plain text with control and bidi characters removed.
 */

export const TITLE_MAX_CHARS = 300;
export const BODY_MAX_BYTES = 64 * 1024;
const LABEL_MAX_CHARS = 100;
const LABELS_MAX = 50;
const GH_TIMEOUT_MS = 20_000;
const GH_OUTPUT_MAX = 4 * 1024 * 1024;
const ISSUE_NUMBER_MAX = 2 ** 31 - 1;

const repoParam = z.string().min(1).max(512);
export const issueImportSchema = z.object({
  repo: repoParam,
  issue: z.union([z.number().int().positive().max(ISSUE_NUMBER_MAX), z.string().min(1).max(2048)]),
}).strict();
export const issueSearchSchema = z.object({
  repo: repoParam,
  query: z.string().min(1).max(256),
  state: z.enum(["open", "closed", "all"]).optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).strict();

/**
 * The published parameter shapes. Bounds are enforced by the schemas above inside the core, so the
 * protocol schema stays small: bounded strings generate a Rust newtype each and the client-protocol
 * crate is at its CRATE-3 generated-size budget.
 */
export const issueImportParams = z.object({ repo: z.string(), issue: z.string() }).strict();
export const issueSearchParams = z.object({ repo: z.string(), query: z.string(), state: z.string().optional(), limit: z.number().int().optional() }).strict();

export type IssueErrorReason =
  | "gh_missing" | "gh_unauthenticated" | "gh_failed" | "rate_limited"
  | "not_github" | "unknown_repo" | "repo_mismatch" | "repo_not_found" | "issue_not_found";

export interface IssueSummary { number: number; title: string; labels: string[]; url: string; state: "open" | "closed" }
export interface ImportedIssue extends IssueSummary {
  /** The pacer repository key and the GitHub `owner/name` the issue was read from. */
  repo: string; github: string;
  body: string;
  truncated: { title: boolean; body: boolean };
}
export interface IssueSearchResult { repo: string; github: string; issues: IssueSummary[] }

/** Runs `gh` with an argument vector. Tests pass a fake that replays recorded output. */
export interface IssueDeps { gh?: (argv: string[]) => Promise<RunResult> }

function fail(code: CoreErrorCode, reason: IssueErrorReason, message: string, hint?: string): never {
  throw new CoreError(code, message, hint, { reason });
}

// Controls (except tab and newline), format characters (bidi overrides, zero-width characters, tag
// characters, U+061C, U+FEFF), lone surrogates, variation selectors and invisible fillers. Hidden text
// could reach an executor's brief without the person confirming it ever seeing it.
const CONTROL = /(?![\n\t])[\p{Cc}\p{Cf}\p{Cs}\u115f\u1160\u3164\uffa0\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu;

/** Plain text with controls removed, cut to `max` code points. */
export function cleanLine(value: string, max: number): { text: string; truncated: boolean } {
  const chars = Array.from(value.replace(/[\r\n\t\u2028\u2029]+/g, " ").replace(CONTROL, "").trim());
  return { text: chars.slice(0, max).join(""), truncated: chars.length > max };
}

/** Multi-line plain text with controls removed and CRLF normalised, cut to `maxBytes` of UTF-8 on a code point boundary. */
export function cleanBody(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const text = value.replace(/\r\n?|[\u2028\u2029]/g, "\n").replace(CONTROL, "");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  let bytes = 0, out = "";
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += ch;
  }
  return { text: out, truncated: true };
}

interface GithubRepo { owner: string; name: string }

function registeredRepo(ctx: Ctx, key: string): RepoRef {
  const repo = listRepos({ ...ctx, readOnly: true }, []).find(r => r.key === key);
  if (!repo) fail("invalid_input", "unknown_repo", `"${key}" is not a registered repository`, "Pass the key of a repository pacer already knows (repo.list).");
  return repo;
}

/** The GitHub repository behind the checkout's `origin` remote. */
async function githubRemote(ctx: Ctx, repo: RepoRef): Promise<GithubRepo> {
  let url: RunResult;
  try { url = await boundedGitRead(ctx.run, ["git", "-C", repo.path, "remote", "get-url", "origin"], 5000); }
  catch { return fail("unavailable", "gh_failed", `Cannot read the git remote of ${repo.label}`, "The repository folder did not respond; check that it is reachable."); }
  const key = url.code === 0 ? repoKey(url.stdout.trim()) : null;
  const match = key ? /^github\.com\/([a-z0-9](?:[a-z0-9-]{0,38}))\/((?!\.\.?$)[a-z0-9._-]{1,100})$/.exec(key) : null;
  if (!match) fail("invalid_input", "not_github", `${repo.label} has no GitHub origin remote`, "Issue import reads issues from the github.com repository named by the origin remote.");
  return { owner: match[1], name: match[2] };
}

/** An issue number from a number, "#123", "123" or an issue URL in the same repository. */
export function parseIssueRef(value: number | string, gh: GithubRepo): number {
  if (typeof value === "number") return value;
  const text = value.trim();
  const plain = /^#?(\d{1,10})$/.exec(text);
  let number: number | undefined;
  if (plain) number = Number(plain[1]);
  else {
    let url: URL;
    try { url = new URL(text); } catch { return fail("invalid_input", "issue_not_found", "Expected an issue number or a GitHub issue URL"); }
    const path = /^\/([^/]+)\/([^/]+)\/issues\/(\d{1,10})\/?$/.exec(url.pathname);
    if (url.protocol !== "https:" || !["github.com", "www.github.com"].includes(url.hostname) || url.username || url.password || url.port || !path) {
      fail("invalid_input", "issue_not_found", "Expected an issue number or a https://github.com/<owner>/<name>/issues/<n> URL");
    }
    if (path[1].toLowerCase() !== gh.owner || path[2].toLowerCase() !== gh.name) {
      fail("invalid_input", "repo_mismatch", `That issue belongs to ${path[1]}/${path[2]}, not ${gh.owner}/${gh.name}`, "Choose the repository the issue belongs to.");
    }
    number = Number(path[3]);
  }
  if (!Number.isSafeInteger(number) || number < 1 || number > ISSUE_NUMBER_MAX) fail("invalid_input", "issue_not_found", "Issue numbers are positive integers");
  return number;
}

function defaultGh(ctx: Ctx): (argv: string[]) => Promise<RunResult> {
  return async argv => {
    const bin = ctx.which("gh");
    if (!bin) fail("unavailable", "gh_missing", "The GitHub CLI (gh) is not installed", "Install gh from https://cli.github.com and run gh auth login.");
    // The user's own gh login is used as is; pacer never reads or stores the token.
    const { GH_DEBUG: _debug, DEBUG: _debugAll, GH_REPO: _repo, GH_HOST: _host, ...inherited } = ctx.env;
    const env = { ...inherited, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1", NO_COLOR: "1", CLICOLOR: "0" };
    return ctx.run([bin, ...argv], GH_TIMEOUT_MS, { env });
  };
}

/** Map a failed gh run to a typed error. `what` names the missing thing for not-found messages. */
function ghFailure(r: RunResult, what: "issue" | "repo"): never {
  const stderr = r.stderr.slice(0, 64 * 1024).replace(CONTROL, "");
  if (r.timedOut) fail("unavailable", "gh_failed", "gh did not answer in time", "Check the network connection and retry.");
  if (/rate limit|HTTP 429|abuse detection/i.test(stderr)) fail("rate_limited", "rate_limited", "GitHub rate limit reached", "Wait a few minutes and retry.");
  if (r.code === 4 || /HTTP 401|gh auth login|not logged in|authentication required|Bad credentials/i.test(stderr)) {
    fail("not_allowed", "gh_unauthenticated", "gh is not signed in to github.com", "Run gh auth login -h github.com, then retry.");
  }
  if (/Could not resolve to a Repository/i.test(stderr)) fail("not_found", "repo_not_found", "GitHub repository not found or not visible to your gh login");
  if (what === "issue" && /Could not resolve to an issue|HTTP 404|no issue found|not found/i.test(stderr)) fail("not_found", "issue_not_found", "Issue not found");
  const line = cleanLine(stderr.split("\n").find(l => l.trim()) ?? `gh exited with code ${r.code}`, 200).text;
  return fail("unavailable", "gh_failed", `gh failed: ${line}`);
}

const ghLabel = z.object({ name: z.string() }).passthrough();
const ghSummary = z.object({ number: z.number().int().positive(), title: z.string(), labels: z.array(ghLabel), url: z.string(), state: z.string() }).passthrough();
const ghIssue = ghSummary.extend({ body: z.string().nullable() });

function parseGh<T extends z.ZodTypeAny>(r: RunResult, schema: T, what: "issue" | "repo"): z.infer<T> {
  if (r.code !== 0 || r.timedOut) ghFailure(r, what);
  if (r.stdout.length > GH_OUTPUT_MAX) fail("unavailable", "gh_failed", "gh returned more output than expected");
  let value: unknown;
  try { value = JSON.parse(r.stdout); } catch { return fail("unavailable", "gh_failed", "gh returned output that is not JSON"); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail("unavailable", "gh_failed", "gh returned JSON in an unexpected shape");
  return parsed.data;
}

const issueUrl = (gh: GithubRepo, n: number) => `https://github.com/${gh.owner}/${gh.name}/issues/${n}`;

/** This repository's canonical URL for the issue, or null when gh returned anything else (another repository, a pull request). */
function ownIssueUrl(raw: z.infer<typeof ghSummary>, gh: GithubRepo): string | null {
  const url = issueUrl(gh, raw.number);
  return raw.url.toLowerCase() === url ? url : null;
}

function summary(raw: z.infer<typeof ghSummary>, url: string): IssueSummary {
  return {
    number: raw.number,
    title: cleanLine(raw.title, TITLE_MAX_CHARS).text,
    labels: raw.labels.slice(0, LABELS_MAX).map(l => cleanLine(l.name, LABEL_MAX_CHARS).text).filter(Boolean),
    url,
    state: raw.state.toUpperCase() === "CLOSED" ? "closed" : "open",
  };
}

function refuseExecutors(ctx: Ctx): void {
  if (isExecutorSession(ctx) || ctx.env.PACER_WORK_GRANT) throw new CoreError("not_allowed", "Issue import is not available to executor sessions");
}

/** Read one issue of a registered repository. Writes nothing. */
export async function importIssue(ctx: Ctx, input: unknown, deps: IssueDeps = {}): Promise<ImportedIssue> {
  refuseExecutors(ctx);
  const parsed = issueImportSchema.safeParse(input);
  if (!parsed.success) throw new CoreError("invalid_input", "Invalid issue import input", parsed.error.issues.map(i => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
  const repo = registeredRepo(ctx, parsed.data.repo);
  const gh = await githubRemote(ctx, repo);
  const number = parseIssueRef(parsed.data.issue, gh);
  const run = deps.gh ?? defaultGh(ctx);
  const raw = parseGh(await run(["issue", "view", String(number), `--repo=github.com/${gh.owner}/${gh.name}`, "--json=number,title,body,labels,url,state"]), ghIssue, "issue");
  const url = raw.number === number ? ownIssueUrl(raw, gh) : null;
  if (!url) fail("not_found", "issue_not_found", `#${number} is not an issue in ${gh.owner}/${gh.name}`, "Pull requests and issues moved to another repository are not imported.");
  const title = cleanLine(raw.title, TITLE_MAX_CHARS), body = cleanBody(raw.body ?? "", BODY_MAX_BYTES);
  return { repo: repo.key, github: `${gh.owner}/${gh.name}`, ...summary(raw, url), body: body.text, truncated: { title: title.truncated, body: body.truncated } };
}

/** Search a registered repository's issues for a picker. Writes nothing. */
export async function searchIssues(ctx: Ctx, input: unknown, deps: IssueDeps = {}): Promise<IssueSearchResult> {
  refuseExecutors(ctx);
  const parsed = issueSearchSchema.safeParse(input);
  if (!parsed.success) throw new CoreError("invalid_input", "Invalid issue search input", parsed.error.issues.map(i => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
  const query = cleanLine(parsed.data.query, 256).text;
  if (!query) fail("invalid_input", "issue_not_found", "The search query is empty");
  const repo = registeredRepo(ctx, parsed.data.repo);
  const gh = await githubRemote(ctx, repo);
  const run = deps.gh ?? defaultGh(ctx);
  const raw = parseGh(await run([
    "issue", "list", `--repo=github.com/${gh.owner}/${gh.name}`, `--search=${query}`,
    `--state=${parsed.data.state ?? "open"}`, `--limit=${parsed.data.limit ?? 20}`, "--json=number,title,labels,url,state",
  ]), z.array(ghSummary), "repo");
  // A repo: or org: qualifier in the query could widen the search; keep only this repository's issues.
  const issues = raw.flatMap(r => {
    const url = ownIssueUrl(r, gh);
    return url ? [summary(r, url)] : [];
  });
  return { repo: repo.key, github: `${gh.owner}/${gh.name}`, issues };
}
