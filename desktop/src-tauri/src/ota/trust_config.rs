//! Shared build-time/runtime parsing of public release trust inputs.
use base64::{engine::general_purpose::STANDARD, Engine};

pub fn validate(public_key: &str, team_id: &str) -> Result<(), ()> {
    if team_id.len() != 10
        || !team_id
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
    {
        return Err(());
    }
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
