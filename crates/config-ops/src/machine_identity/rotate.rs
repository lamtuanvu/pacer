//! Key rotation and recovery of an interrupted rotation (`src/identity/rotate.ts`).
use super::{
    Code, CoreError, Ctx, Env, Key, LockOptions, Meta, Slot, Value, clear_cache,
    clear_transport_keys, delete_private_key, io_error, js_number, keychain_backend, load_locked,
    lock_error, new_salt, next_rev, read_meta, read_private_key, read_salt, salt_hash, sha256_hex,
    truthy, with_identity_lock, with_lock, write_meta, write_private_key, write_salt,
};
use base64::Engine;
use serde_json::{Map, json};
use std::fs;

const SIG_DOMAIN: &str = "pacer-machine-sig/v1";
const AUDIT_MAX_BYTES: u64 = 1024 * 1024;

fn signed_message(plugin_id: &str, purpose: &str, payload: &[u8]) -> Vec<u8> {
    let mut message = format!("{SIG_DOMAIN}\0{plugin_id}\0{purpose}\0").into_bytes();
    message.extend_from_slice(payload);
    message
}

/// Host-owned, append-only signature log; moves to `.1` at 1 MiB under the `identity-audit` lock.
fn audit_signed(
    ctx: &Ctx,
    plugin_id: &str,
    purpose: &str,
    payload: &[u8],
    machine_id: &str,
) -> Result<(), CoreError> {
    let path = ctx.pacer_home.join("logs").join("identity-audit.jsonl");
    let line = json!({"at":js_number(ctx.now),"pluginId":plugin_id,"purpose":purpose,"sha256":sha256_hex(payload),"outcome":"signed","machineId":machine_id});
    let mut bytes = serde_json::to_vec(&line).map_err(io_error)?;
    bytes.push(b'\n');
    let dir = ctx.pacer_home.join("logs");
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)
            .map_err(io_error)?;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(io_error)?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(&dir).map_err(io_error)?;
    let full = || fs::metadata(&path).is_ok_and(|m| m.len() >= AUDIT_MAX_BYTES);
    if full() {
        with_lock(ctx, "identity-audit", LockOptions::default(), || {
            if full() {
                let mut moved = path.as_os_str().to_os_string();
                moved.push(".1");
                fs::rename(&path, moved).map_err(io_error)?;
            }
            Ok(())
        })
        .map_err(lock_error)??;
    }
    let mut options = fs::OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    std::io::Write::write_all(&mut options.open(&path).map_err(io_error)?, &bytes)
        .map_err(io_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(io_error)?;
    }
    Ok(())
}

/// The old key signs `oldId 0x00 newId` with plugin id `pacer` and purpose `rotate`.
fn sign_rotation(ctx: &Ctx, old: &Key, new_id: &str) -> Result<String, CoreError> {
    let payload = format!("{}\0{new_id}", old.id).into_bytes();
    let signature = old.sign(&signed_message("pacer", "rotate", &payload));
    audit_signed(ctx, "pacer", "rotate", &payload, &old.id)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(signature))
}

fn field<'a>(pending: &'a Map<String, Value>, key: &str) -> &'a str {
    pending.get(key).and_then(Value::as_str).unwrap_or("")
}

/// Announce a committed rotation: activity line, then the `machine` entity event.
fn announce(ctx: &Ctx, pending: &Map<String, Value>) -> Result<(), CoreError> {
    let (old_id, new_id) = (field(pending, "oldId"), field(pending, "newId"));
    let short = |id: &str| id.chars().take(8).collect::<String>();
    pacer_store::append_activity(
        ctx,
        json!({"kind":"config","level":"info","text":format!("Machine identity rotated ({} → {})", short(old_id), short(new_id))}),
    )
    .map_err(io_error)?;
    let event = json!({"type":"entity","data":{"kind":"machine","id":"self","value":{"event":"rotated","oldId":pending.get("oldId"),"newId":pending.get("newId"),"signature":pending.get("signature")}}});
    for error in pacer_store::publish(ctx, &[event]).errors {
        eprintln!("pacer: machine rotation publication failed: {error}");
    }
    Ok(())
}

/// Finish a rotation whose new key is current: store `salt`, drop the staged key, commit machine.json.
fn commit(
    ctx: &Ctx,
    env: &Env<'_>,
    meta: &Meta,
    pending: &Map<String, Value>,
    salt: &str,
) -> Result<Meta, CoreError> {
    let keychain = keychain_backend(meta.get("backend"));
    clear_transport_keys(ctx)?;
    write_salt(ctx, env, salt)?;
    delete_private_key(ctx, env, keychain, Slot::Staging)?;
    let mut next = meta.clone();
    for key in ["cloneDetected", "cloneDetectedAt", "pendingRotation"] {
        next.shift_remove(key);
    }
    next.insert("rev".into(), next_rev(meta.get("rev")));
    next.insert(
        "publicId".into(),
        pending.get("newId").cloned().unwrap_or(Value::Null),
    );
    next.insert(
        "rotatedFrom".into(),
        pending.get("oldId").cloned().unwrap_or(Value::Null),
    );
    next.insert("saltHash".into(), Value::String(salt_hash(salt)));
    let mut last = Map::new();
    for key in ["oldId", "newId", "signature"] {
        if let Some(value) = pending.get(key) {
            last.insert(key.into(), value.clone());
        }
    }
    last.insert("at".into(), js_number(ctx.now));
    next.insert("lastRotation".into(), Value::Object(last));
    write_meta(ctx, &next)?;
    Ok(next)
}

/// Restore the old key and machine.json after a failed key write. When that fails too, the
/// pending record stays and the next load completes the rotation from the staged key.
fn undo(
    ctx: &Ctx,
    env: &Env<'_>,
    meta: &Meta,
    old: &Key,
    keychain: bool,
    error: CoreError,
) -> CoreError {
    let restored = (|| {
        let current = read_private_key(ctx, env, keychain, Slot::Current)?;
        if current.map(|k| k.id).as_deref() != Some(old.id.as_str()) {
            write_private_key(ctx, env, keychain, old, Slot::Current)?;
        }
        write_meta(ctx, meta)
    })();
    if restored.is_ok() {
        let _ = delete_private_key(ctx, env, keychain, Slot::Staging);
    }
    error
}

/// Replace the machine key under the identity lock: sign with the old key, record
/// `pendingRotation`, stage, swap, then commit. Nothing is announced before the commit.
pub(crate) fn rotate(ctx: &Ctx, env: &Env<'_>) -> Result<Value, CoreError> {
    with_identity_lock(ctx, || rotate_locked(ctx, env))
}

fn rotate_locked(ctx: &Ctx, env: &Env<'_>) -> Result<Value, CoreError> {
    let (old, old_key) = load_locked(ctx, env)?;
    let meta = read_meta(ctx)?.ok_or_else(|| super::internal("machine.json is missing"))?;
    let key = Key::generate()?;
    let new_id = key.id.clone();
    let salt = new_salt()?;
    let signature = sign_rotation(ctx, &old_key, &new_id)?;
    let pending = json!({"oldId":old.id,"newId":new_id,"signature":signature,"stagedAt":js_number(ctx.now),"saltHash":salt_hash(&salt)});
    let pending = pending.as_object().cloned().unwrap_or_default();
    let keychain = keychain_backend(meta.get("backend"));
    let mut staged = meta.clone();
    staged.insert("pendingRotation".into(), Value::Object(pending.clone()));
    write_meta(ctx, &staged)?;
    write_private_key(ctx, env, keychain, &key, Slot::Staging)
        .map_err(|e| undo(ctx, env, &meta, &old_key, keychain, e))?;
    write_private_key(ctx, env, keychain, &key, Slot::Current)
        .map_err(|e| undo(ctx, env, &meta, &old_key, keychain, e))?;
    let finished = (|| {
        // The new key is in place, so the rotation only goes forward: retry once, then leave it to the next load.
        if commit(ctx, env, &meta, &pending, &salt).is_err()
            && commit(ctx, env, &meta, &pending, &salt).is_err()
        {
            let mut data = Map::new();
            data.insert("rotationPending".into(), Value::Bool(true));
            data.insert("oldId".into(), Value::String(old.id.clone()));
            data.insert("newId".into(), Value::String(new_id.clone()));
            return Err(CoreError::new(
                Code::Unavailable,
                "The new machine key is in place, but pacer could not finish the rotation. It completes the next time pacer loads the machine identity.",
            )
            .hint("Run pacer machine show to finish it now.")
            .data(data));
        }
        announce(ctx, &pending)
    })();
    clear_cache();
    finished?;
    Ok(json!({"oldId":old.id,"newId":new_id}))
}

/// Complete an interrupted rotation whose new key was stored, or roll it back. Runs under the identity lock.
pub(super) fn recover(ctx: &Ctx, env: &Env<'_>, meta: Meta) -> Result<Meta, CoreError> {
    let pending = match meta.get("pendingRotation") {
        Some(Value::Object(p)) => p.clone(),
        _ => Map::new(),
    };
    let keychain = keychain_backend(meta.get("backend"));
    let mut rest = meta.clone();
    rest.shift_remove("pendingRotation");
    let mut salt: Option<String> = None;
    if truthy(meta.get("saltHash")) && !truthy(meta.get("cloneDetected")) {
        // A home copied mid-rotation finds no salt or a foreign one: flag it and drop the rotation.
        salt = read_salt(ctx, env)?;
        let hash = match salt.as_deref() {
            Some(s) if !s.is_empty() => Value::String(salt_hash(s)),
            _ => Value::Null,
        };
        if meta.get("saltHash") != Some(&hash) && pending.get("saltHash") != Some(&hash) {
            let mut flagged = rest;
            flagged.insert("cloneDetected".into(), Value::Bool(true));
            flagged.insert("cloneDetectedAt".into(), js_number(ctx.now));
            write_meta(ctx, &flagged)?;
            delete_private_key(ctx, env, keychain, Slot::Staging)?;
            return Ok(flagged);
        }
        if pending.get("saltHash") != Some(&hash) {
            salt = None;
        }
    }
    let new_id = pending.get("newId").and_then(Value::as_str);
    let is_new = |key: &Key| new_id == Some(key.id.as_str());
    let current = read_private_key(ctx, env, keychain, Slot::Current)?;
    if !current.as_ref().is_some_and(is_new) {
        match read_private_key(ctx, env, keychain, Slot::Staging)? {
            Some(staged) if is_new(&staged) => {
                write_private_key(ctx, env, keychain, &staged, Slot::Current)?;
            }
            _ => {
                write_meta(ctx, &rest)?;
                delete_private_key(ctx, env, keychain, Slot::Staging)?;
                return Ok(rest);
            }
        }
    }
    let salt = match salt {
        Some(salt) => salt,
        None => new_salt()?,
    };
    let next = commit(ctx, env, &meta, &pending, &salt)?;
    announce(ctx, &pending)?;
    Ok(next)
}
