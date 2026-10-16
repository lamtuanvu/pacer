import tokens from "./tokens.json";

/** The JSON is the source of truth; escape token names such as space-1.5. */
export function generateTokens(): string {
  const variable = (name: string, value: string | number) => `  --${name.replaceAll(".", "\\.")}: ${value};`;
  const colors = (theme: "light" | "dark") => tokens.color.tokens.map(t => variable(t.name, t.value[theme])).join("\n");
  const type = tokens.type.groups.flatMap(g => g.styles.flatMap(s => [
    variable(`type-${s.name}-size`, s.fontSize), variable(`type-${s.name}-line`, s.lineHeight), variable(`type-${s.name}-weight`, s.fontWeight),
    ...("letterSpacing" in s ? [variable(`type-${s.name}-tracking`, s.letterSpacing!)] : []),
  ]));
  return `/* Generated from tokens.json. */\n:root {\n  color-scheme: light dark;\n${colors("light")}\n${[
    ...Object.entries(tokens.type.families).map(([name, value]) => variable(`font-${name}`, value)), ...type,
    ...tokens.spacing.tokens.map(t => variable(t.name, t.value)), ...tokens.radius.tokens.map(t => variable(t.name, t.value)),
  ].join("\n")}\n  font-variant-numeric: tabular-nums;\n}\n@media (prefers-color-scheme: dark) {\n:root:not([data-theme="light"]) {\n${colors("dark")}\n}\n}\n:root[data-theme="dark"] {\n${colors("dark")}\n}\n`;
}
