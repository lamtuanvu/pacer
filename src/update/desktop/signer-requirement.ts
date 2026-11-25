/** Compiled code-signing pins. Mirrors desktop/src-tauri/src/ota/trust.rs exactly. */
export type SignerPins = { appleTeamId?: string | null; signingCertSha1?: string | null };
const TEAM = /^[A-Z0-9]{10}$/, CERT = /^[0-9A-F]{40}$/, IDENTIFIER = /^[a-z0-9.-]+$/;

declare const PACER_BUILD_APPLE_TEAM_ID: string | undefined;
declare const PACER_BUILD_SIGNING_CERT_SHA1: string | undefined;

/** Moved from the retired native provider so `--pacer-identity` keeps reporting compiled trust. */
export function compiledAppleTeamId(): string | null {
  const team = typeof PACER_BUILD_APPLE_TEAM_ID === "string" ? PACER_BUILD_APPLE_TEAM_ID : "";
  return TEAM.test(team) ? team : null;
}
export function compiledSigningCertSha1(): string | null {
  const cert = typeof PACER_BUILD_SIGNING_CERT_SHA1 === "string" ? PACER_BUILD_SIGNING_CERT_SHA1 : "";
  return CERT.test(cert) ? cert : null;
}
export function compiledSignerPins(): SignerPins | null {
  const pins = { appleTeamId: compiledAppleTeamId(), signingCertSha1: compiledSigningCertSha1() };
  return validSignerPins(pins) ? pins : null;
}

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
