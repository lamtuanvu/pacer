/**
 * Combine per-schema JSON Schemas into one `$defs` bundle for `cargo xtask gen`.
 * `z.toJSONSchema` gives each schema its own `$defs` (for example `__schema0` for a recursive type);
 * those are lifted to the top level under `<owner>_<name>` and every `$ref` is rewritten to match.
 */
export function bundleDefs(schemas: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [owner, schema] of Object.entries(schemas)) {
    const { $schema: _s, $defs: local, ...body } = (schema ?? {}) as Record<string, unknown>;
    const names = Object.keys((local ?? {}) as Record<string, unknown>);
    const rename = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(rename);
      if (!v || typeof v !== "object") return v;
      return Object.fromEntries(Object.entries(v).map(([k, x]) => {
        if (k === "$ref" && typeof x === "string") {
          const m = /^#\/\$defs\/(.+)$/.exec(x);
          if (m && names.includes(m[1]!)) return [k, `#/$defs/${owner}_${m[1]}`];
          if (x === "#") return [k, `#/$defs/${owner}`];
        }
        return [k, rename(x)];
      }));
    };
    out[owner] = rename(body);
    for (const n of names) out[`${owner}_${n}`] = rename((local as Record<string, unknown>)[n]);
  }
  return out;
}
