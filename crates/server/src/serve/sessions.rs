//! Hashed browser sessions, compatible with the core's app-auth store.
use pacer_foundation::Ctx;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
};

pub const SESSION_SECONDS: f64 = 30.0 * 86400.0;

fn read(ctx: &Ctx) -> io::Result<Vec<Value>> {
    let bytes = match fs::read(ctx.pacer_home.join("app/sessions.json")) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(error),
    };
    let value: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => return Ok(vec![]),
    };
    Ok(value
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter(|row| {
                    row["hash"].as_str().is_some_and(|hash| {
                        hash.len() == 64
                            && hash
                                .bytes()
                                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    }) && row["expiresAt"]
                        .as_f64()
                        .is_some_and(|expiry| expiry > ctx.now)
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default())
}

fn write(ctx: &Ctx, records: &[Value]) -> io::Result<()> {
    let dir = ctx.pacer_home.join("app");
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)?;
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    let temp = dir.join(format!(
        ".sessions.{}.tmp",
        hex::encode(rand::random::<[u8; 12]>())
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)?;
    let result = (|| {
        let mut bytes = serde_json::to_vec(records)?;
        bytes.push(b'\n');
        file.write_all(&bytes)?;
        fs::rename(&temp, dir.join("sessions.json"))
    })();
    let _ = fs::remove_file(&temp);
    result
}

/// Create a session using the same sha256-hex record format as app-auth.ts.
pub fn create(ctx: &Ctx) -> io::Result<String> {
    let value = hex::encode(rand::random::<[u8; 32]>());
    let mut records = read(ctx)?;
    records.push(json!({"hash": hex::encode(Sha256::digest(value.as_bytes())), "expiresAt": ctx.now + SESSION_SECONDS}));
    write(ctx, &records)?;
    Ok(value)
}

/// Validate and slide expiry only when more than one day has elapsed.
pub fn check(ctx: &Ctx, value: &str) -> io::Result<bool> {
    let mut records = read(ctx)?;
    let digest = hex::encode(Sha256::digest(value.as_bytes()));
    let Some(record) = records.iter_mut().find(|row| {
        row["hash"]
            .as_str()
            .is_some_and(|hash| super::auth::safe_equal(hash, &digest))
    }) else {
        return Ok(false);
    };
    if record["expiresAt"]
        .as_f64()
        .is_some_and(|expiry| expiry - ctx.now < SESSION_SECONDS - 86400.0)
    {
        record["expiresAt"] = json!(ctx.now + SESSION_SECONDS);
        write(ctx, &records)?;
    }
    Ok(true)
}
