//! Machine identity under `<PACER_HOME>/identity`, sharing files, Keychain items,
//! the install salt and the `identity` lock with `src/identity/`.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
    js_semantics::js_trim,
    lock::{LockError, LockOptions, with_lock},
};
use ring::{
    rand::{SecureRandom, SystemRandom},
    signature::{Ed25519KeyPair, KeyPair},
};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        LazyLock, Mutex,
        atomic::{AtomicU8, Ordering},
    },
    time::{Duration, Instant},
};

mod rotate;
pub(crate) use rotate::rotate;

type Meta = Map<String, Value>;

const IDENTITY_DIR: &str = "identity";
const IDENTITY_LOCK: &str = "identity";
const KEYCHAIN_SERVICE: &str = "pacer";
const SECURITY_TIMEOUT: Duration = Duration::from_secs(10);
/// Node exports Ed25519 private keys as PKCS#8 v1: this prefix and the 32-byte seed.
const PKCS8_V1_PREFIX: [u8; 16] = [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

/// Failures other than a `CoreError` reach clients as `internal`, as `toApiError` reports them.
fn internal(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::Internal, message)
}

fn io_error(error: impl std::fmt::Display) -> CoreError {
    internal(error.to_string())
}

fn lock_error(error: LockError) -> CoreError {
    io_error(error)
}

fn with_identity_lock<T>(
    ctx: &Ctx,
    f: impl FnOnce() -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    with_lock(ctx, IDENTITY_LOCK, LockOptions::default(), f).map_err(lock_error)?
}

/// ECMAScript truthiness of an optional JSON value.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(_) => true,
    }
}

fn js_number(n: f64) -> Value {
    if n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 {
        Value::from(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

/// `meta.rev + 1` for a numeric revision; anything else becomes `NaN`, which JSON writes as null.
fn next_rev(rev: Option<&Value>) -> Value {
    match rev {
        Some(Value::Number(n)) if n.is_i64() => Value::from(n.as_i64().unwrap_or(0) + 1),
        Some(Value::Number(n)) => js_number(n.as_f64().unwrap_or(f64::NAN) + 1.0),
        _ => Value::Null,
    }
}

fn random_bytes<const N: usize>() -> Result<[u8; N], CoreError> {
    let mut out = [0u8; N];
    SystemRandom::new()
        .fill(&mut out)
        .map_err(|_| CoreError::new(Code::Internal, "random source unavailable"))?;
    Ok(out)
}

const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

/// RFC 4648 base32, lowercase, no padding.
pub(crate) fn base32(bytes: &[u8]) -> String {
    let (mut out, mut bits, mut value) = (String::new(), 0u32, 0u32);
    for &byte in bytes {
        value = (value << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            out.push(ALPHABET[((value >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
        value &= (1 << bits) - 1;
    }
    if bits > 0 {
        out.push(ALPHABET[((value << (5 - bits)) & 31) as usize] as char);
    }
    out
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Temp file opened exclusively with 0600 in a 0700 directory, fsynced, renamed over
/// the target, then the directory fsynced (SEC-7), as `writePrivateFile`.
fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), CoreError> {
    let dir = path
        .parent()
        .ok_or_else(|| internal("private file has no directory"))?;
    let result = (|| -> std::io::Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(dir)?;
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
        }
        #[cfg(not(unix))]
        fs::create_dir_all(dir)?;
        let nonce = random_bytes::<16>().map_err(|e| std::io::Error::other(e.message))?;
        let mut temp = path.as_os_str().to_os_string();
        temp.push(format!(".{}.tmp", hex::encode(nonce)));
        let temp = PathBuf::from(temp);
        let written = (|| {
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temp, path)?;
            fs::File::open(dir)?.sync_all()
        })();
        let _ = fs::remove_file(&temp);
        written
    })();
    result.map_err(io_error)
}

fn meta_path(ctx: &Ctx) -> PathBuf {
    ctx.pacer_home.join(IDENTITY_DIR).join("machine.json")
}

fn read_meta(ctx: &Ctx) -> Result<Option<Meta>, CoreError> {
    let path = meta_path(ctx);
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read(&path).map_err(io_error)?;
    match serde_json::from_slice::<Value>(&text).map_err(io_error)? {
        Value::Object(meta) => Ok(Some(meta)),
        _ => Err(internal("machine.json is not an object")),
    }
}

fn write_meta(ctx: &Ctx, meta: &Meta) -> Result<(), CoreError> {
    let mut text = serde_json::to_string_pretty(meta).map_err(io_error)?;
    text.push('\n');
    write_private_file(&meta_path(ctx), text.as_bytes())
}

fn clear_transport_keys(ctx: &Ctx) -> Result<(), CoreError> {
    write_private_file(
        &ctx.pacer_home
            .join(IDENTITY_DIR)
            .join("transport-keys.json"),
        b"{}\n",
    )
}

/// Node's `path.resolve`: absolute and lexically normalized.
fn resolve(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The real path, resolving the nearest existing ancestor so it is stable before and after creation.
fn canonical_path(path: &Path) -> PathBuf {
    let absolute = resolve(path);
    if absolute.exists() {
        return fs::canonicalize(&absolute).unwrap_or(absolute);
    }
    match (absolute.parent(), absolute.file_name()) {
        (Some(parent), Some(name)) => canonical_path(parent).join(name),
        _ => absolute,
    }
}

/// Per-home suffix for Keychain accounts and the install salt (`homeTag`).
fn home_tag(ctx: &Ctx) -> String {
    let path = canonical_path(&ctx.pacer_home);
    let mut hasher = Sha256::new();
    hasher.update(b"pacer-home/v1\0");
    hasher.update(path.to_string_lossy().as_bytes());
    hex::encode(hasher.finalize())[..16].to_owned()
}

/// Runs the macOS `security` tool; returns its exit code and stdout. Spawn failures report 127.
pub(crate) trait Security: Sync {
    fn run(&self, args: &[&str], stdin: Option<&str>) -> (i32, String);
}

struct SystemSecurity;

impl Security for SystemSecurity {
    fn run(&self, args: &[&str], stdin: Option<&str>) -> (i32, String) {
        let child = Command::new("security")
            .args(args)
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        let Ok(mut child) = child else {
            return (127, String::new());
        };
        if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
            let _ = pipe.write_all(text.as_bytes());
        }
        let reader = child.stdout.take().map(|mut out| {
            std::thread::spawn(move || {
                let mut text = String::new();
                let _ = out.read_to_string(&mut text);
                text
            })
        });
        let deadline = Instant::now() + SECURITY_TIMEOUT;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status.code().unwrap_or(-1),
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break -1;
                }
            }
        };
        let stdout = reader.and_then(|r| r.join().ok()).unwrap_or_default();
        (status, stdout)
    }
}

const PLATFORM_NATIVE: u8 = 0;
const PLATFORM_DARWIN: u8 = 1;
static PLATFORM: AtomicU8 = AtomicU8::new(PLATFORM_NATIVE);

/// Test hook matching `setIdentityPlatformForTests`: `darwin` selects the Keychain, anything else files.
#[doc(hidden)]
pub fn set_identity_platform_for_tests(platform: Option<&str>) {
    let value = match platform {
        None => PLATFORM_NATIVE,
        Some("darwin") => PLATFORM_DARWIN,
        Some(_) => 2,
    };
    PLATFORM.store(value, Ordering::SeqCst);
}

/// Where machine-wide secrets live: the platform default backend and the `security` runner.
pub(crate) struct Env<'a> {
    pub keychain: bool,
    pub security: &'a dyn Security,
}

impl Env<'static> {
    pub(crate) fn system() -> Self {
        let keychain = match PLATFORM.load(Ordering::SeqCst) {
            PLATFORM_NATIVE => cfg!(target_os = "macos"),
            value => value == PLATFORM_DARWIN,
        };
        Env {
            keychain,
            security: &SystemSecurity,
        }
    }
}

fn find_password(env: &Env<'_>, account: &str) -> Result<Option<String>, CoreError> {
    let args = [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        account,
        "-w",
    ];
    let (code, stdout) = env.security.run(&args, None);
    if code == 44 {
        return Ok(None);
    }
    if code != 0 {
        return Err(internal("machine identity keychain read failed"));
    }
    let printed = stdout
        .strip_suffix("\r\n")
        .or_else(|| stdout.strip_suffix('\n'))
        .unwrap_or(&stdout);
    Ok(Some(printed.to_owned()))
}

fn write_password(
    env: &Env<'_>,
    account: &str,
    value: &[u8],
    matches: impl Fn(&str) -> bool,
) -> Result<(), CoreError> {
    let input = format!(
        "add-generic-password -U -s {KEYCHAIN_SERVICE} -a {account} -X {}\n",
        hex::encode(value)
    );
    let failed = || internal("machine identity keychain write failed");
    let (code, _) = env.security.run(&["-i"], Some(&input));
    if code != 0 {
        return Err(failed());
    }
    match find_password(env, account) {
        Ok(Some(back)) if matches(&back) => Ok(()),
        _ => Err(failed()),
    }
}

fn delete_password(env: &Env<'_>, account: &str) -> Result<(), CoreError> {
    let args = [
        "delete-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        account,
    ];
    let (code, _) = env.security.run(&args, None);
    if code != 0 && code != 44 {
        return Err(internal("machine identity keychain delete failed"));
    }
    Ok(())
}

pub(crate) struct Key {
    der: Vec<u8>,
    pair: Ed25519KeyPair,
    pub id: String,
}

impl Key {
    fn from_der(der: Vec<u8>) -> Result<Self, CoreError> {
        let pair = Ed25519KeyPair::from_pkcs8_maybe_unchecked(&der)
            .map_err(|_| internal("machine identity key is not a valid Ed25519 PKCS#8 key"))?;
        let id = base32(pair.public_key().as_ref());
        Ok(Self { der, pair, id })
    }

    fn generate() -> Result<Self, CoreError> {
        let mut der = PKCS8_V1_PREFIX.to_vec();
        der.extend_from_slice(&random_bytes::<32>()?);
        Self::from_der(der)
    }

    fn sign(&self, message: &[u8]) -> Vec<u8> {
        self.pair.sign(message).as_ref().to_vec()
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Slot {
    Current,
    Staging,
}

fn key_path(ctx: &Ctx, slot: Slot) -> PathBuf {
    ctx.pacer_home.join(IDENTITY_DIR).join(match slot {
        Slot::Current => "machine.key",
        Slot::Staging => "machine.key.staging",
    })
}

fn key_account(ctx: &Ctx, slot: Slot) -> String {
    let prefix = match slot {
        Slot::Current => "machine-identity",
        Slot::Staging => "machine-identity-staging",
    };
    format!("{prefix}/{}", home_tag(ctx))
}

/// The key backend recorded in machine.json: anything but `"file"` is the Keychain.
fn keychain_backend(backend: Option<&Value>) -> bool {
    backend.and_then(Value::as_str) != Some("file")
}

fn read_private_key(
    ctx: &Ctx,
    env: &Env<'_>,
    keychain: bool,
    slot: Slot,
) -> Result<Option<Key>, CoreError> {
    if !keychain {
        let path = key_path(ctx, slot);
        if !path.exists() {
            return Ok(None);
        }
        return Key::from_der(fs::read(path).map_err(io_error)?).map(Some);
    }
    let Some(printed) = find_password(env, &key_account(ctx, slot))? else {
        return Ok(None);
    };
    let der = hex::decode(js_trim(&printed))
        .map_err(|_| internal("machine identity key is not a valid Ed25519 PKCS#8 key"))?;
    Key::from_der(der).map(Some)
}

fn write_private_key(
    ctx: &Ctx,
    env: &Env<'_>,
    keychain: bool,
    key: &Key,
    slot: Slot,
) -> Result<(), CoreError> {
    if !keychain {
        return write_private_file(&key_path(ctx, slot), &key.der);
    }
    write_password(env, &key_account(ctx, slot), &key.der, |printed| {
        hex::decode(js_trim(printed)).is_ok_and(|back| back == key.der)
    })
}

fn delete_private_key(
    ctx: &Ctx,
    env: &Env<'_>,
    keychain: bool,
    slot: Slot,
) -> Result<(), CoreError> {
    if !keychain {
        return match fs::remove_file(key_path(ctx, slot)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(io_error(e)),
            _ => Ok(()),
        };
    }
    delete_password(env, &key_account(ctx, slot))
}

fn salt_account(ctx: &Ctx) -> String {
    format!("machine-install-salt/{}", home_tag(ctx))
}

/// One salt per PACER_HOME, outside it, so a copied home finds none under its own tag.
fn salt_path(ctx: &Ctx) -> PathBuf {
    let state = ctx
        .env
        .get("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| ctx.home.join(".local").join("state"));
    state.join("pacer").join("install-salt").join(home_tag(ctx))
}

/// The install salt, or None when missing. Other failures are errors, not evidence of a copy.
fn read_salt(ctx: &Ctx, env: &Env<'_>) -> Result<Option<String>, CoreError> {
    if !env.keychain {
        let path = salt_path(ctx);
        if !path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(path).map_err(io_error)?;
        return Ok(Some(js_trim(&String::from_utf8_lossy(&bytes)).to_owned()));
    }
    Ok(find_password(env, &salt_account(ctx))?.map(|s| js_trim(&s).to_owned()))
}

fn write_salt(ctx: &Ctx, env: &Env<'_>, salt: &str) -> Result<(), CoreError> {
    if !env.keychain {
        return write_private_file(&salt_path(ctx), format!("{salt}\n").as_bytes());
    }
    write_password(env, &salt_account(ctx), salt.as_bytes(), |printed| {
        js_trim(printed) == salt
    })
}

fn new_salt() -> Result<String, CoreError> {
    Ok(hex::encode(random_bytes::<32>()?))
}

fn salt_hash(salt: &str) -> String {
    sha256_hex(salt.as_bytes())
}

/// The loaded identity without its private key; `clone_suspected` is the check made at load.
#[derive(Clone)]
pub(crate) struct Identity {
    pub id: String,
    name: Option<Value>,
    rev: Option<Value>,
    clone_suspected: bool,
    last_rotation: Option<Value>,
}

fn build(meta: &Meta, key: &Key) -> Identity {
    Identity {
        id: key.id.clone(),
        name: meta.get("name").cloned(),
        rev: meta.get("rev").cloned(),
        clone_suspected: truthy(meta.get("cloneDetected")),
        last_rotation: meta
            .get("lastRotation")
            .filter(|v| truthy(Some(v)))
            .cloned(),
    }
}

fn default_name() -> Result<String, CoreError> {
    Ok(format!("pacer-{}", &base32(&random_bytes::<3>()?)[..4]))
}

/// Load, create or recover the identity from disk. The caller holds the identity lock.
fn load_locked(ctx: &Ctx, env: &Env<'_>) -> Result<(Identity, Key), CoreError> {
    let mut meta = read_meta(ctx)?;
    if let Some(m) = &meta
        && truthy(m.get("pendingRotation"))
    {
        meta = Some(rotate::recover(ctx, env, m.clone())?);
    }
    let keychain = match meta.as_ref().and_then(|m| m.get("backend")) {
        None | Some(Value::Null) => env.keychain,
        backend => keychain_backend(backend),
    };
    let key = read_private_key(ctx, env, keychain, Slot::Current)?;
    if let Some(m) = &mut meta
        && !truthy(m.get("cloneDetected"))
    {
        let salt_bad = truthy(m.get("saltHash"))
            && match read_salt(ctx, env)? {
                Some(salt) if !salt.is_empty() => {
                    m.get("saltHash") != Some(&Value::String(salt_hash(&salt)))
                }
                _ => true,
            };
        if key.is_none() || salt_bad {
            m.insert("cloneDetected".into(), Value::Bool(true));
            m.insert("cloneDetectedAt".into(), js_number(ctx.now));
            write_meta(ctx, m)?;
        }
    }
    let (meta, key) = match (meta, key) {
        (Some(meta), Some(key)) => (meta, key),
        (meta, _) => {
            if meta.is_some() {
                clear_transport_keys(ctx)?;
            }
            let key = Key::generate()?;
            write_private_key(ctx, env, keychain, &key, Slot::Current)?;
            let salt = new_salt()?;
            write_salt(ctx, env, &salt)?;
            let meta = match meta {
                Some(mut m) => {
                    let rev = next_rev(m.get("rev"));
                    m.insert("rev".into(), rev);
                    m.insert("createdAt".into(), js_number(ctx.now));
                    m.insert("saltHash".into(), Value::String(salt_hash(&salt)));
                    m
                }
                None => {
                    let backend = if keychain { "keychain" } else { "file" };
                    let fresh = json!({"rev":1,"name":default_name()?,"createdAt":js_number(ctx.now),"backend":backend,"saltHash":salt_hash(&salt)});
                    fresh.as_object().cloned().unwrap_or_default()
                }
            };
            (meta, key)
        }
    };
    let identity = build(&meta, &key);
    if meta.get("publicId") != Some(&Value::String(identity.id.clone())) {
        let mut stamped = meta;
        stamped.insert("publicId".into(), Value::String(identity.id.clone()));
        write_meta(ctx, &stamped)?;
    }
    Ok((identity, key))
}

/// The identity cached per PACER_HOME, valid while machine.json keeps the same stamp.
static CACHE: LazyLock<Mutex<HashMap<PathBuf, (String, Identity)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Every identity change in any process rewrites machine.json by rename, so a new stamp means stale.
fn meta_stamp(ctx: &Ctx) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let m = fs::metadata(meta_path(ctx)).ok()?;
        let mtime = i128::from(m.mtime()) * 1_000_000_000 + i128::from(m.mtime_nsec());
        let ctime = i128::from(m.ctime()) * 1_000_000_000 + i128::from(m.ctime_nsec());
        Some(format!("{}:{}:{mtime}:{ctime}", m.ino(), m.size()))
    }
    #[cfg(not(unix))]
    {
        let _ = ctx;
        None
    }
}

fn clear_cache() {
    if let Ok(mut cache) = CACHE.lock() {
        cache.clear();
    }
}

fn ensure(ctx: &Ctx, env: &Env<'_>) -> Result<Identity, CoreError> {
    let stamp = meta_stamp(ctx);
    if let (Some(stamp), Ok(mut cache)) = (&stamp, CACHE.lock()) {
        match cache.get(&ctx.pacer_home) {
            Some((cached, identity)) if cached == stamp => return Ok(identity.clone()),
            Some(_) => {
                cache.remove(&ctx.pacer_home);
            }
            None => {}
        }
    }
    let (identity, stamp) =
        with_identity_lock(ctx, || Ok((load_locked(ctx, env)?.0, meta_stamp(ctx))))?;
    if let (Some(stamp), Ok(mut cache)) = (stamp, CACHE.lock()) {
        cache.insert(ctx.pacer_home.clone(), (stamp, identity.clone()));
    }
    Ok(identity)
}

/// `machineView`: after a rotation it repeats the old key's signed statement.
fn view(identity: &Identity) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), Value::String(identity.id.clone()));
    if let Some(name) = &identity.name {
        out.insert("name".into(), name.clone());
    }
    if let Some(rev) = &identity.rev {
        out.insert("rev".into(), rev.clone());
    }
    out.insert(
        "cloneSuspected".into(),
        Value::Bool(identity.clone_suspected),
    );
    if let Some(last) = &identity.last_rotation
        && last.get("newId").and_then(Value::as_str) == Some(identity.id.as_str())
    {
        for (from, to) in [("oldId", "rotatedFrom"), ("signature", "rotationSignature")] {
            if let Some(value) = last.get(from) {
                out.insert(to.into(), value.clone());
            }
        }
    }
    Value::Object(out)
}

pub(crate) fn machine_get(ctx: &Ctx, env: &Env<'_>) -> Result<Value, CoreError> {
    Ok(view(&ensure(ctx, env)?))
}

fn stripped(c: char) -> bool {
    matches!(c,
        '\u{0000}'..='\u{001f}' | '\u{007f}'..='\u{009f}' | '\u{061c}' |
        '\u{200b}'..='\u{200f}' | '\u{2028}' | '\u{2029}' | '\u{202a}'..='\u{202e}' |
        '\u{2066}'..='\u{2069}' | '\u{feff}'
    )
}

/// Drop control, bidirectional and zero-width characters, then keep 1-64 code points.
fn sanitize_name(raw: &str) -> Result<String, CoreError> {
    let kept: String = raw.chars().filter(|&c| !stripped(c)).collect();
    let cut: String = js_trim(&kept).chars().take(64).collect();
    let name = js_trim(&cut);
    if name.is_empty() {
        return Err(invalid("Machine name is empty").hint("Use 1-64 visible characters."));
    }
    Ok(name.to_owned())
}

pub(crate) fn machine_set(
    ctx: &Ctx,
    env: &Env<'_>,
    name: &str,
    expect_rev: i64,
) -> Result<Value, CoreError> {
    let clean = sanitize_name(name)?;
    with_identity_lock(ctx, || {
        load_locked(ctx, env)?;
        let mut meta = read_meta(ctx)?.ok_or_else(|| internal("machine.json is missing"))?;
        let actual = meta.get("rev").cloned();
        if actual.as_ref().and_then(Value::as_f64) != Some(expect_rev as f64) {
            let mut data = Map::new();
            data.insert("expected".into(), Value::from(expect_rev));
            if let Some(actual) = actual {
                data.insert("actual".into(), actual);
            }
            return Err(
                CoreError::new(Code::Conflict, "Machine name changed in another client")
                    .hint("Reload and try again.")
                    .data(data),
            );
        }
        meta.insert("name".into(), Value::String(clean));
        meta.insert("rev".into(), next_rev(actual.as_ref()));
        write_meta(ctx, &meta)
    })?;
    clear_cache();
    machine_get(ctx, env)
}

#[cfg(test)]
mod tests;
