//! Shared build-time/runtime parsing of public release trust inputs.
use base64::{engine::general_purpose::STANDARD, Engine};

pub fn validate(public_key: &str, team_id: &str) -> Result<(), ()> {
    validate_team(team_id)?;
    validate_key(public_key)
}
/// A production build pins at least one signer: an Apple Team ID, the SHA-1 of
/// the project's self-signed code-signing certificate, or both (bridge release).
#[allow(dead_code)]
pub fn validate_signers(team_id: Option<&str>, cert_sha1: Option<&str>) -> Result<(), ()> {
    if team_id.is_none() && cert_sha1.is_none() {
        return Err(());
    }
    team_id.map_or(Ok(()), validate_team)?;
    cert_sha1.map_or(Ok(()), validate_cert)
}
pub fn validate_team(team_id: &str) -> Result<(), ()> {
    if team_id.len() != 10
        || !team_id
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
    {
        return Err(());
    }
    Ok(())
}
#[allow(dead_code)]
pub fn validate_cert(cert_sha1: &str) -> Result<(), ()> {
    if cert_sha1.len() != 40
        || !cert_sha1
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
    {
        return Err(());
    }
    Ok(())
}
pub fn validate_key(public_key: &str) -> Result<(), ()> {
    let decoded = STANDARD.decode(public_key).map_err(|_| ())?;
    let text = std::str::from_utf8(&decoded).map_err(|_| ())?;
    let mut lines = text.lines();
    if !lines
        .next()
        .is_some_and(|line| line.starts_with("untrusted comment: "))
    {
        return Err(());
    }
    let packet = STANDARD.decode(lines.next().ok_or(())?).map_err(|_| ())?;
    if lines.next().is_some() || packet.len() != 42 || &packet[..2] != b"Ed" {
        return Err(());
    }
    Ok(())
}
