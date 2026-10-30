/** Remove a trailing bracket group when the source or a clipped prefix leaves it unfinished. */
export function balancedPrefix(text: string): string {
  const stack: { bracket: string; at: number }[] = [];
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    if ("([{“".includes(char)) stack.push({ bracket: char, at });
    else if (")]}”".includes(char)) {
      const open = stack.at(-1);
      if (open && "([{“".indexOf(open.bracket) === ")]}”".indexOf(char)) stack.pop();
    }
  }
  return (stack.length ? text.slice(0, stack[0]!.at) : text).trim();
}

/** Inline destinations may themselves contain balanced parentheses. */
function linkText(text: string): string {
  let result = "", rest = text;
  for (;;) {
    const link = /!?\[([^\]]+)\]\(/.exec(rest);
    if (!link) return result + rest;
    const start = link.index + link[0].length;
    let end = start, depth = 1;
    for (; end < rest.length && depth; end++) {
      if (rest[end] === "(") depth++;
      else if (rest[end] === ")") depth--;
    }
    result += rest.slice(0, link.index) + link[1];
    rest = rest.slice(end);
  }
}

/** Human-readable fallback for a brief without an explicit title. The execution goal stays intact. */
export function goalTitle(goal: string): string {
  const lines = goal.slice(0, 4000).replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, "").split(/\r?\n/);
  for (const line of lines) {
    const plain = linkText(line)
      .replace(/!?\[([^\]]+)\]\[[^\]]*\]/g, "$1")
      .replace(/^\s*(?:(?:#{1,6}\s*|>\s*|[-+*]\s+|\d+[.)]\s+))+/, "")
      .replace(/[`*~]/g, "")
      .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "")
      .replace(/\s+#+\s*$/, "")
      .replace(/\s+/g, " ").trim();
    if (!plain || /^(?:goal|task|summary|context):?$/i.test(plain)) continue;
    const sentence = balancedPrefix(plain.split(/[.!?](?:\s|$)/, 1)[0]!);
    if (!sentence) continue;
    const points = Array.from(sentence);
    if (points.length <= 80) return sentence;
    const prefix = points.slice(0, 79).join("");
    const boundary = prefix.lastIndexOf(" ");
    return (balancedPrefix(boundary > 0 ? prefix.slice(0, boundary) : prefix) || "Task") + "…";
  }
  return "Task";
}

/** Recognize older generated labels without treating a custom short title as a goal prefix. */
export function generatedGoalTitle(title: string, goal: string): boolean {
  return title === goal.trim() || (title.endsWith("…") || balancedPrefix(title) !== title)
    && goal.trim().startsWith(title.replace(/…$/, ""));
}
