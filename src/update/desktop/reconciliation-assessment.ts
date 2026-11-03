/** Internal diagnostic observations, never authorization or native proof. Unknown fields
 * are ignored for forward compatibility; all fields used below must be recognized. */
export function assessReconciliation(value: unknown): { status: "unknown" | "external" | "incompatible" | "mismatch" | "unverified"; reason: string; capability: "unavailable"; revision: number } {
  const result = (status: "unknown" | "external" | "incompatible" | "mismatch" | "unverified", reason: string) => ({ status, reason, capability: "unavailable" as const, revision: 0 });
  if (!value || typeof value !== "object" || Array.isArray(value)) return result("unknown", "peer-data-unavailable");
  const v = value as Record<string, unknown>;
  if (v.protocolMajor === undefined) return result("unknown", "peer-data-unavailable");
  if (v.protocolMajor !== 3) return result("unknown", "unsupported-protocol");
  if (!(["managed", "external"].includes(v.ownership as string)) || !(["supported", "unavailable"].includes(v.platform as string)) || !(["compatible", "newer", "incompatible"].includes(v.compatibility as string)) || !(["present", "missing"].includes(v.capabilities as string)) || !(["match", "mismatch", "unverified"].includes(v.identity as string))) return result("unknown", "peer-data-unavailable");
  if (v.ownership === "external") return result("external", "external-ownership");
  if (v.platform === "unavailable") return result("unknown", "platform-unavailable");
  if (v.compatibility !== "compatible") return result("incompatible", v.compatibility === "newer" ? "source-newer" : "incompatible-source");
  if (v.capabilities === "missing") return result("unknown", "missing-capability");
  if (v.identity === "mismatch") return result("mismatch", "pair-differs");
  return result("unverified", "native-proof-unavailable");
}
