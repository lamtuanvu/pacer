import { homedir } from "node:os";

/** pacer's own identifiers and commit SHAs survive redaction so the assistant can still quote them. */
const ALLOW = [/^t-\d{8}-\d{6}-[0-9a-f]{4}$/, /^[0-9a-f]{40}$/, /^[0-9a-f]{64}$/, /^(?:task|att|req|run|conv|turn|work)[-_][A-Za-z0-9_-]{4,}$/, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/];
const allowed = (token: string): boolean => ALLOW.some(re => re.test(token));
const REDACTED = "[redacted]";

const KEY_PREFIX = /\b(?:sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|pk_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{30,})\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const AUTH_HEADER = /\bauthorization\s*[:=]\s*[^\r\n]*/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g;
const PEM = /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE|PUBLIC KEY)-----[\s\S]*?(?:-----END [A-Z0-9 ]*-----|$)/g;
const ASSIGNMENT = /((?:api[_-]?key|access[_-]?token|secret|password|passwd|token)["']?\s*[=:]\s*["']?)[^\s"',;]{4,}/gi;
const LONG_TOKEN = /[A-Za-z0-9_+/=-]{32,}/g;

/** Shannon entropy per character; filters long but ordinary words and paths. */
function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) { const p = n / text.length; h -= p * Math.log2(p); }
  return h;
}

export interface Redactor { text(value: string): string; json<T>(value: T): T }

/** Replaces exact secret values, key-shaped strings, PEM blocks and the home path. Idempotent. */
export function createRedactor(secrets: readonly string[] = [], home: string = homedir()): Redactor {
  const exact = [...new Set(secrets.filter(s => s.length >= 4))].sort((a, b) => b.length - a.length);
  const text = (input: string): string => {
    let out = input;
    for (const secret of exact) out = out.split(secret).join(REDACTED);
    out = out.replace(PEM, REDACTED).replace(AUTH_HEADER, `Authorization: ${REDACTED}`).replace(BEARER, `Bearer ${REDACTED}`)
      .replace(JWT, REDACTED).replace(KEY_PREFIX, REDACTED).replace(ASSIGNMENT, `$1${REDACTED}`);
    out = out.replace(LONG_TOKEN, token => allowed(token) || /^[A-Za-z]+$/.test(token) || token.includes("/") && !/[0-9]/.test(token) || entropy(token) < 3.6 ? token : REDACTED);
    if (home.length > 1) out = out.split(home).join("~");
    return out;
  };
  const json = <T>(value: T): T => {
    if (typeof value === "string") return text(value) as T;
    if (Array.isArray(value)) return value.map(item => json(item)) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, json(v)])) as T;
    return value;
  };
  return { text, json };
}
