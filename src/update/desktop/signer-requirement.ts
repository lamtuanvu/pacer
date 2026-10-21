/** Compiled code-signing pins. Mirrors desktop/src-tauri/src/ota/trust.rs exactly. */
export type SignerPins = { appleTeamId?: string | null; signingCertSha1?: string | null };
const TEAM = /^[A-Z0-9]{10}$/, CERT = /^[0-9A-F]{40}$/, IDENTIFIER = /^[a-z0-9.-]+$/;

export function validSignerPins(pins: SignerPins): boolean {
  const { appleTeamId: team, signingCertSha1: cert } = pins;
  return (!!team || !!cert) && (!team || TEAM.test(team)) && (!cert || CERT.test(cert));
}
export function signerKind(pins: SignerPins): "apple" | "self" | "both" | null {
  return pins.appleTeamId ? (pins.signingCertSha1 ? "both" : "apple") : pins.signingCertSha1 ? "self" : null;
}
/** One role's designated requirement. The Developer ID form is kept byte-for-byte. */
export function signerRequirement(identifier: string, pins: SignerPins): string {
  if (!IDENTIFIER.test(identifier) || !validSignerPins(pins)) throw Error("Invalid signer pins");
  const apple = pins.appleTeamId ? `anchor apple generic and certificate leaf[subject.OU] = "${pins.appleTeamId}"` : null;
  const own = pins.signingCertSha1 ? `certificate leaf = H"${pins.signingCertSha1}"` : null;
  if (apple && !own) return `anchor apple generic and identifier "${identifier}" and certificate leaf[subject.OU] = "${pins.appleTeamId}"`;
  if (own && !apple) return `identifier "${identifier}" and ${own}`;
  return `identifier "${identifier}" and ((${apple}) or ${own})`;
}
