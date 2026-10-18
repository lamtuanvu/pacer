/** Clip display titles by code point, leaving room for an ellipsis. */
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

/** A compact display label; never changes the goal used to execute a task. */
export function shortTitle(goal: string): string {
  // Bound all parsing work, including regexes, even for very large briefs.
  const input = goal.slice(0, 400);
  let basename = "";
  const text = input
    .replace(/```[\s\S]*?(?:```|$)|`[^`]*(?:`|$)/g, " ")
    .replace(/(?:https?:\/\/|www\.)[^\s<>]+/gi, match => " " + (match.match(/[.!?;:,]+$/)?.[0] ?? ""));
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*#{1,6}\s*/, "").replace(/^\s*(?:goal|task|summary|context)\s*(?::\s*|$)/i, "");
    // Match whole tokens first, then use anchored path checks. Never scan every
    // suffix of a long slash-less token looking for a path prefix.
    const cleaned = line.replace(/[^\s<>]+/g, token => {
      const candidate = token.replace(/^[([{"']+|[)\]}"',;:!?]+$/g, "").replace(/\.+$/, "");
      const path = /^(?:\/|\.{1,2}\/|~\/|[A-Za-z]:[\\/])/.test(candidate)
        || candidate.split("/").length >= 3
        || /^[^:]+\.[A-Za-z0-9]{1,10}$/.test(candidate);
      if (!path) return token;
      const file = candidate.split(/[\\/]/).at(-1) ?? "";
      basename ||= file.replace(/\.[^.]*$/, "").replace(leadingMarkers, "").trim();
      return " " + (token.match(/[.!?;:,]+$/)?.[0] ?? "");
    }).replace(/\s+/g, " ").trim();
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
