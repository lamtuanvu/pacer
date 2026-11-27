//! Single-use sign-in codes, byte-compatible with `src/serve/app-auth.ts`.
//!
//! The TypeScript store writes `app/codes.json` (0600 in a 0700 directory) as
//! sha256-hex records with a 60 second expiry and no lock; this port keeps that
//! format and concurrency contract exactly.
use pacer_foundation::Ctx;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
};

pub const CODE_SECONDS: f64 = 60.0;

fn read(ctx: &Ctx) -> io::Result<Vec<Value>> {
    let bytes = match fs::read(ctx.pacer_home.join("app/codes.json")) {
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
        ".codes.{}.tmp",
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
        fs::rename(&temp, dir.join("codes.json"))
    })();
    let _ = fs::remove_file(&temp);
    result
}

/// Create a code with the same record format and lifetime as TypeScript's `createCode`.
pub fn create(ctx: &Ctx) -> io::Result<String> {
    let value = hex::encode(rand::random::<[u8; 32]>());
    let mut records = read(ctx)?;
    records.push(json!({
        "hash": hex::encode(Sha256::digest(value.as_bytes())),
        "expiresAt": ctx.now + CODE_SECONDS,
    }));
    write(ctx, &records)?;
    Ok(value)
}

/// Redeem a code once. The matching record is removed before it is written back, so a
/// replay cannot mint a second session (SEC: single-use).
pub fn redeem(ctx: &Ctx, code: &str) -> io::Result<bool> {
    let mut records = read(ctx)?;
    let digest = hex::encode(Sha256::digest(code.as_bytes()));
    let Some(index) = records.iter().position(|row| {
        row["hash"]
            .as_str()
            .is_some_and(|hash| super::auth::safe_equal(hash, &digest))
    }) else {
        return Ok(false);
    };
    records.remove(index);
    write(ctx, &records)?;
    Ok(true)
}
