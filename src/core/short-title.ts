/** Compact fallback for surfaces without CSS layout (status lines and notifications). */
export function clipTitle(title: string): string {
  const points = Array.from(title);
  if (points.length <= 60) return title;
  const prefix = points.slice(0, 59).join("");
  const boundary = prefix.lastIndexOf(" ");
  return (boundary > 0 ? prefix.slice(0, boundary) : prefix).trimEnd() + "…";
}

const leadingMarkers = /^[\s\p{P}>+=~|]+/u;
function capitalize(text: string): string {
  return text.replace(/\p{L}/u, letter => letter.toUpperCase());
}

const URL_MARK = "\u0001url";
// Words that would dangle after a title is cut before a path ("Update the config in").
const danglingWords = /(?:\s+(?:in|on|at|to|for|from|of|and|or|with|into|under|via|by|the|a|an))+\s*$/i;
/**
 * Real paths only: rooted, home- or ./-relative, drive-letter, or slash-separated with a file or
 * several segments. Bare file names (calc.py, .env) and words like and/or or TCP/IP are kept.
 */
function isPath(token: string): boolean {
  return /^(?:\/|\.{1,2}\/|~|[A-Za-z]:[\\/])/.test(token)
    || token.split("/").length >= 3
    || (token.includes("/") && /\.[A-Za-z0-9]{1,10}$/.test(token));
}

/** A compact display label; never changes the goal used to execute a task. */
export function shortTitle(goal: string): string {
  // Bound all parsing work, including regexes, even for very large briefs.
  const input = goal.slice(0, 400);
  let basename = "";
  const text = input
    .replace(/```[\s\S]*?(?:```|$)|`[^`]*(?:`|$)/g, " ")
    .replace(/(?:https?:\/\/|www\.)[^\s<>]+/gi, match => ` ${URL_MARK}${match.match(/[.!?;:,]+$/)?.[0] ?? ""}`);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*#{1,6}\s*/, "").replace(/^\s*(?:goal|task|summary|context)\s*(?::\s*|$)/i, "");
    let cleaned = "";
    for (const token of line.split(/[\s<>]+/)) {
      if (!token) continue;
      const candidate = token.replace(/^[([{"']+|[)\]}"',;:!?]+$/g, "").replace(/\.+$/, "");
      const url = candidate === URL_MARK;
      if (!url && !isPath(candidate)) { cleaned += " " + token; continue; }
      const punctuation = token.match(/[.!?;:,]+$/)?.[0] ?? "";
      if (!url) basename ||= (candidate.split(/[\\/]/).at(-1) ?? "").replace(/\.[^.]*$/, "").replace(leadingMarkers, "").trim();
      // A path inside a sentence would leave a hole ("Fix X in so it works"): end the title before it.
      if (cleaned.split(/[.!?;:,](?:\s|$)/).at(-1)!.replace(leadingMarkers, "").trim()) { cleaned = cleaned.replace(danglingWords, "") + punctuation; break; }
      cleaned += " " + punctuation;
    }
    cleaned = cleaned.replace(/\s+/g, " ").trim();
    for (const part of cleaned.split(/[.!?;:,](?:\s|$)|\s[—–]\s/)) {
      const clause = part.replace(leadingMarkers, "").trim();
      if (clause) return clipTitle(capitalize(clause));
    }
  }
  // Only use a path basename when code or URLs did not also supply content.
  return clipTitle(capitalize((text === input && basename) || "Task"));
}

// Cache by id across reloaded records, invalidating if a goal changes.
const legacyTitles = new Map<string, {goal: string; title: string}>();
const legacyTitleLimit = 1000;
export function taskTitle(task: { id?: string; title?: string; brief: { goal: string } }): string {
  if (task.title?.trim()) return clipTitle(task.title.trim());
  const goal = task.brief.goal;
  if (task.id) {
    const cached = legacyTitles.get(task.id);
    if (cached?.goal === goal) return cached.title;
  }
  const title = shortTitle(goal);
  if (task.id) {
    if (legacyTitles.size >= legacyTitleLimit) legacyTitles.delete(legacyTitles.keys().next().value!);
    legacyTitles.set(task.id, {goal, title});
  }
  return title;
}

/** Complete display text for layout-aware clients, including records with generated short titles. */
export function fullTaskTitle(task: { title?: string; brief: { goal: string } }): string {
  const title = task.title?.trim();
  const goal = task.brief.goal.trim();
  if (!title || title === clipTitle(goal) || title === shortTitle(goal)) return goal || title || "Task";
  return title;
}
