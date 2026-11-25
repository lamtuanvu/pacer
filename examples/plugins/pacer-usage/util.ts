/** Unix seconds from unix s/ms (number or numeric string) or ISO-8601; null when unparseable. */
export function parseTs(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? (raw > 1e12 ? raw / 1000 : raw) : null;
  const s = String(raw).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const v = Number(s);
    return v > 1e12 ? v / 1000 : v;
  }
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms / 1000;
}

export function toNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
