//! Internal, inactive proof of a socket peer against a separately validated bundle role.
use super::OtaError;

#[derive(Clone, Copy)]
pub(super) struct Evidence {
    pub(super) static_valid: bool,
    pub(super) guest_valid: bool,
    pub(super) token_available: bool,
    pub(super) process_unchanged: bool,
    pub(super) file_unchanged: bool,
    pub(super) role_matches: bool,
}
pub(super) fn check_evidence(e: &Evidence) -> Result<(), OtaError> {
    if e.static_valid
        && e.guest_valid
        && e.token_available
        && e.process_unchanged
        && e.file_unchanged
        && e.role_matches
    {
        // Native observations are not a transaction-bound selection seal or grant.
        // Until those exist, even complete observations cannot authorize effects.
        Err(OtaError::Unavailable)
    } else {
        Err(OtaError::Identity)
    }
}

/// Diagnostic observations only. Caller-supplied trust and path are not authority;
/// this function cannot succeed until selection and transaction sealing are proved.
#[cfg(target_os = "macos")]
fn verify_bundle_peer(
    trust: &crate::ota::trust::ReleaseTrust,
    bundle: &std::path::Path,
    role: crate::ota::trust::CodeRole,
    expected: &crate::ota::native::ProcessIdentity,
    socket: &std::os::unix::net::UnixStream,
) -> Result<(), OtaError> {
    use crate::ota::trust::CodeRole;
    use core_foundation::{base::TCFType, data::CFData, url::CFURL};
    use security_framework::os::macos::code_signing::{
        Flags, GuestAttributes, SecCode, SecRequirement, SecStaticCode,
    };
    use std::os::unix::fs::MetadataExt;

    let bundle = bundle.canonicalize().map_err(|_| OtaError::Identity)?;
    trust.verify_static(&bundle, CodeRole::Desktop)?;
    let path = bundle.join(match role {
        CodeRole::Desktop => "Contents/MacOS/pacer",
        CodeRole::Cli => "Contents/Resources/pacer",
        CodeRole::Helper => "Contents/Resources/pacer-update-helper",
    });
    if path.canonicalize().map_err(|_| OtaError::Identity)? != path {
        return Err(OtaError::Identity);
    }
    let before = crate::ota::native::process_details(expected.pid)
        .map_err(|_| OtaError::Identity)?
        .ok_or(OtaError::Identity)?;
    if before.identity != *expected
        || before.uid != unsafe { libc::geteuid() }
        || before.executable != path
    {
        return Err(OtaError::Identity);
    }
    trust.verify_static(&path, role)?;
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| OtaError::Identity)?;
    if !metadata.is_file() {
        return Err(OtaError::Identity);
    }
    let url = CFURL::from_path(&path, false).ok_or(OtaError::Identity)?;
    let code = SecStaticCode::from_path(&url, Flags::NONE).map_err(|_| OtaError::Identity)?;
    let role_requirement: SecRequirement = trust
        .requirement(role)
        .parse()
        .map_err(|_| OtaError::Identity)?;
    code.check_validity(
        Flags::STRICT_VALIDATE | Flags::CHECK_NESTED_CODE | Flags::CHECK_ALL_ARCHITECTURES,
        &role_requirement,
    )
    .map_err(|_| OtaError::Identity)?;
    let cdhash = crate::ota::bootstrap_identity::signing_cdhash(&code)?;
    let requirement: SecRequirement =
        format!("({}) and cdhash H\"{}\"", trust.requirement(role), cdhash)
            .parse()
            .map_err(|_| OtaError::Identity)?;
    // A fresh token is obtained from the connected socket; no PID-only lookup.
    let token = crate::ota::control::peer_token(socket)?;
    if u32::from_ne_bytes(token[20..24].try_into().map_err(|_| OtaError::Identity)?) != expected.pid
    {
        return Err(OtaError::Identity);
    }
    let token = CFData::from_buffer(&token);
    let mut attrs = GuestAttributes::new();
    attrs.set_audit_token(token.as_concrete_TypeRef());
    let guest = SecCode::copy_guest_with_attribues(None, &attrs, Flags::NONE)
        .map_err(|_| OtaError::Identity)?;
    guest
        .check_validity(Flags::NONE, &requirement)
        .map_err(|_| OtaError::Identity)?;
    let after = crate::ota::native::process_details(expected.pid)
        .map_err(|_| OtaError::Identity)?
        .ok_or(OtaError::Identity)?;
    let checked = std::fs::symlink_metadata(&path).map_err(|_| OtaError::Identity)?;
    let same_file = metadata.dev() == checked.dev()
        && metadata.ino() == checked.ino()
        && metadata.size() == checked.size()
        && metadata.mode() == checked.mode()
        && metadata.uid() == checked.uid()
        && metadata.gid() == checked.gid()
        && metadata.nlink() == checked.nlink()
        && metadata.mtime() == checked.mtime()
        && metadata.mtime_nsec() == checked.mtime_nsec()
        && metadata.ctime() == checked.ctime()
        && metadata.ctime_nsec() == checked.ctime_nsec();
    check_evidence(&Evidence {
        static_valid: true,
        guest_valid: true,
        token_available: true,
        process_unchanged: before == after,
        file_unchanged: same_file,
        role_matches: true,
    })
}
