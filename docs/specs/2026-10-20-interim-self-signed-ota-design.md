# Interim self-signed desktop OTA releases

Date: 2026-10-20
Status: Design approved by the maintainer in conversation on 2026-10-20, section by section. The written spec awaits the maintainer's review.
Extends: [macOS desktop OTA updates](2026-10-19-desktop-ota-design.md), [ADR 0001](../decisions/0001-desktop-ota.md).

## Intent and agreed scope

Publish desktop OTA releases publicly before the project has an Apple Developer ID account. Releases must keep the native helper's identity guarantees. Installed interim builds must later move to Developer ID builds through ordinary OTA updates, without user action.

The maintainer chose:

- Public GitHub releases from the existing stable feed, not a separate channel.
- A seamless OTA bridge to Developer ID.
- A project-owned, self-signed code-signing certificate whose hash is compiled into builds ("approach A").

Rejected alternatives:

- Ad-hoc signing with per-build cdhash pins in the Ed25519 manifest. A build cannot contain its own hash, so this needs more trust code. Its identity also changes on every update, which causes macOS permission and keychain re-prompts.
- Ad-hoc signing with identifier-only requirements. Any local process could impersonate a pacer role.

Out of scope: Linux, the CLI/npm/Homebrew packages, Windows, and any change to the Ed25519 updater signature or feed format.

## Spike findings (macOS, arm64, 2026-10-20)

- `codesign` signs with a self-signed certificate that the keychain reports as `CSSMERR_TP_NOT_TRUSTED`.
- `identifier "<id>" and certificate leaf = H"<sha1>"` is satisfied, statically and for a running PID. A wrong hash fails, and an ad-hoc impostor with the same identifier fails.
- With hardened runtime (`--options runtime`), a host cannot load a dylib signed by the same self-signed certificate: "mapping process and mapped file (non-platform) have different Team IDs". A self-signed certificate has no Team ID. Without hardened runtime, the dylib loads.

Consequence: self-signed builds run without hardened runtime. Library validation is never disabled through an entitlement (ADR 0001). Hardened runtime is required only for notarization, which these builds do not use.

## Trust model

`ota-production` remains the only shipping trust flavor. It compiles one or both signer pins:

| Pin | Build variable | Requirement alternative |
| --- | --- | --- |
| Apple | `PACER_APPLE_TEAM_ID` (10 uppercase alphanumerics) | `anchor apple generic and certificate leaf[subject.OU] = "<TEAM>"` |
| Self | `PACER_SIGNING_CERT_SHA1` (40 uppercase hex) | `certificate leaf = H"<SHA1>"` |

- Every role's requirement is `identifier "<role id>" and (<alternatives joined by or>)`. With one pin, the parentheses hold that one alternative.
- The build fails when neither pin is set or when a pin is malformed. `trust_config::validate` enforces both formats.
- All existing checks use the generated requirement unchanged: static bundle, running process, socket peer, native library and helper. Fixture trust is unchanged unless the harness option below is used.
- The helper's runtime self-test keeps `otaMode: "production"` and adds `signer: "apple" | "self" | "both"`. It also reports the compiled pins.

### What each key protects

- The self-signed certificate's private key decides which local processes the helper accepts as pacer roles.
- The Ed25519 updater key still decides what is installed.

Neither key alone can push a malicious update. The SHA-1 pin is safe against forgery: matching it requires a second preimage, not a collision.

### Certificate

- RSA-3072 with critical `keyUsage=digitalSignature` and critical `extendedKeyUsage=codeSigning`.
- Subject CN `pacer interim code signing`, lifetime 20 years.
- One certificate for the whole interim period. Rotating it requires a bridge release, the same way as the Developer ID move.
- Implementation tests confirm that verification does not depend on the certificate's validity dates.

### Developer ID bridge

1. Interim releases pin only the self-signed certificate.
2. After the Developer ID account exists, one bridge release is signed with the self-signed certificate and compiled with both pins.
3. Later releases are Developer ID-signed and notarized, and pin only the Team ID.

Each step is an ordinary OTA update, because the running version's trust verifies the next one. Nothing is pinned in advance.

## Release pipeline

- **Credentials.** New secrets `PACER_SELF_SIGNING_CERTIFICATE_BASE64` and `PACER_SELF_SIGNING_CERTIFICATE_PASSWORD`, and the variable `PACER_SIGNING_CERT_SHA1`.
  - `desktop-credentials.ts` imports the certificate into the existing short-lived keychain and cleans it up the same way.
  - Configuring both Apple and self-signing credentials is refused, except for the bridge release, which is signed with the self-signed certificate and compiled with both pins.
- **Signing (`desktop-sign.ts`), split by signer:**
  - Apple: unchanged (hardened runtime, timestamp, notarize, staple, `spctl`).
  - Self:
    - Sign every component with the certificate. Use no `--options runtime` and pass `--timestamp=none`; Apple's timestamp service accepts only Apple-issued certificates.
    - Before signing, check that the compiled pin equals the certificate's SHA-1, the same way the existing Team ID check works.
    - Verify every component with `codesign --verify --strict -R=<compiled requirement>`.
    - Run the helper's runtime self-test.
    - Never call `notarytool`, `stapler` or `spctl`.
  - Both signers: the Ed25519 updater signature on the archive is unchanged.
- **Release validation (`desktop-release.ts validate`).**
  - Still requires both architectures before the feed advances.
  - Its signature check follows the signer and pins recorded in each package's metadata.
  - The stable feed and the immutable assets keep their format.
- **Workflow (`release.yml`).**
  - `desktop-build` keeps the `PACER_DESKTOP_RELEASE_ENABLED` switch.
  - It selects the signer from whichever credentials are configured.
  - The step names stop claiming notarization on the self-signed path.

### First install

- The release notes and README gain an "Install on macOS" section. Open the app once; when macOS blocks it, use System Settings › Privacy & Security › Open Anyway.
- Terminal users may instead run `xattr -dr com.apple.quarantine /Applications/pacer.app`.
- OTA updates do not prompt, because the helper's downloads carry no quarantine attribute.
- Because the designated requirement stays stable across releases, macOS keeps privacy and keychain grants after each update.

## Governance

OD-5 keeps desktop publication gated until Developer ID signing is verified. Shipping interim releases needs:

- **An exception in `.project/decisions.md`.**
  - Scope: public desktop releases signed with the pinned self-signed certificate, with no notarization.
  - Conditions: both architectures validate, and the CT-11 evidence below exists.
  - Expiry: the Developer ID bridge release.
- **An addendum to ADR 0001** recording the signer pins, the hardened-runtime finding and the bridge.

Both are drafted with this spec. Merging the PR that carries them is the maintainer's acceptance.

## Testing and validation

- **Rust unit tests (`trust.rs`, `trust_config.rs`):**
  - Exact requirement strings for Apple, self and both pins, for every role.
  - Refusals for a malformed hash (length, case, quote injection) and for a missing pin.
  - The existing Team ID refusals are kept.
- **macOS signature tests:**
  - A test helper creates a disposable self-signed certificate in a temporary keychain. It signs a small executable and dylib.
  - `verify_static` and `verify_process` accept both under the cert pin. They reject an ad-hoc impostor and a different certificate.
  - The dylib loads only without hardened runtime. This guards against adding `--options runtime` to the self-signed path.
  - Skipped off macOS.
- **TS tests (`desktop-sign`, `desktop-credentials`):**
  - Signer selection.
  - Refusal of both credential sets outside the bridge, of neither, and of a pin that doesn't match the certificate.
  - On the self-signed path: no notarization, stapling or `spctl` calls, and no runtime option.
- **CI fixture job.** "Exercise local fixture signing, immutable retry and feed promotion" adds a self-signed pass. It runs the real self-signed branch with a disposable certificate, then `validate` and local feed promotion.
- **Live validation (CT-11).**
  - The live harness gains a `--signer cert` fixture build option. It signs fixtures with a disposable certificate and adds the cert pin to the fixture requirement, so fixtures check identifier, cert pin and lease confinement.
  - The managed `update`, restoration and `adopt` scenarios are rerun under it.
- **UNVERIFIED until observed:**
  - The first public interim release: the first-install Gatekeeper flow, then an OTA from release N to N+1 through the stable feed.
  - Intel execution.
  - The Developer ID bridge.
