//! ADR 0021: one recorded owner for the whole pacer installation, at
//! `$PACER_HOME/owner.json`. The TS CLI side lives at `src/install/owner.ts` in the
//! repository root and reads/writes the identical JSON shape; both must agree on it.
use serde::{Deserialize, Serialize};
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnerRecord {
    pub schema: u32,
    pub owner: String, // "cli" | "desktop"
    pub executable: String,
    pub at: u64,
}

pub fn owner_path(pacer_home: &Path) -> PathBuf {
    pacer_home.join("owner.json")
}

/// A missing or malformed record means "no recorded owner". Never panics or errors out
/// for the caller: every failure mode collapses to `None`, matching the TS `readOwner`.
pub fn read_owner(pacer_home: &Path) -> Option<OwnerRecord> {
    let bytes = fs::read(owner_path(pacer_home)).ok()?;
    let record: OwnerRecord = serde_json::from_slice(&bytes).ok()?;
    if record.schema != 1 || (record.owner != "cli" && record.owner != "desktop") || !Path::new(&record.executable).is_absolute() {
        return None;
    }
    Some(record)
}

/// Atomic: mode 0600, temp file + rename, the same pattern as `consent.json` /
/// `cli-choice.json` (see `write_consent` in client.rs and `link::remember`).
pub fn write_owner(pacer_home: &Path, owner: &str, executable: &Path, now: SystemTime) -> Result<(), String> {
    DirBuilder::new().recursive(true).mode(0o700).create(pacer_home).map_err(|e| e.to_string())?;
    let at = now.duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs();
    let record = OwnerRecord { schema: 1, owner: owner.into(), executable: executable.to_string_lossy().into_owned(), at };
    let contents = serde_json::to_vec(&record).map_err(|e| e.to_string())?;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let temp = pacer_home.join(format!(
        ".owner-{}-{}-{}.tmp",
        std::process::id(),
        now.duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temp).map_err(|e| e.to_string())?;
    let result = (|| {
        file.write_all(&contents)?;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        file.sync_all()?;
        fs::rename(&temp, owner_path(pacer_home))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|error: io::Error| error.to_string())
}

/// The desktop becomes the recorded owner unconditionally on consent (Welcome/Consent
/// screen, `write_consent`) or on a completed service takeover (ADR 0011): the user's
/// consent or confirmation IS the authorization, unlike the CLI's `claimCliOwnership`
/// (TS side), which only claims an absent or already-cli record.
pub fn claim_desktop_ownership(pacer_home: &Path, bundled_cli: &Path, now: SystemTime) -> Result<(), String> {
    write_owner(pacer_home, "desktop", bundled_cli, now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering as StdOrdering};

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "pacer-owner-test-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
                NEXT.fetch_add(1, StdOrdering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn missing_or_malformed_record_reads_as_none() {
        let dir = TempDir::new();
        assert!(read_owner(&dir.0).is_none());
        fs::write(owner_path(&dir.0), "not json").unwrap();
        assert!(read_owner(&dir.0).is_none());
        fs::write(owner_path(&dir.0), r#"{"schema":1,"owner":"nobody","executable":"/x","at":1}"#).unwrap();
        assert!(read_owner(&dir.0).is_none());
        fs::write(owner_path(&dir.0), r#"{"schema":2,"owner":"cli","executable":"/x","at":1}"#).unwrap();
        assert!(read_owner(&dir.0).is_none());
        fs::write(owner_path(&dir.0), r#"{"schema":1,"owner":"cli","executable":"relative","at":1}"#).unwrap();
        assert!(read_owner(&dir.0).is_none());
    }

    #[test]
    fn write_owner_round_trips_and_is_private_and_atomic() {
        let dir = TempDir::new();
        let now = UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        write_owner(&dir.0, "desktop", Path::new("/Applications/pacer.app/Contents/Resources/pacer"), now).unwrap();
        let record = read_owner(&dir.0).unwrap();
        assert_eq!(record, OwnerRecord { schema: 1, owner: "desktop".into(), executable: "/Applications/pacer.app/Contents/Resources/pacer".into(), at: 1_700_000_000 });
        use std::os::unix::fs::PermissionsExt;
        let path = owner_path(&dir.0);
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        // No leftover temp files after a successful write.
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
        write_owner(&dir.0, "cli", Path::new("/usr/local/bin/pacer"), now).unwrap();
        assert_eq!(read_owner(&dir.0).unwrap().owner, "cli");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    /// A canonical owner.json, byte for byte. test/install-owner.test.ts's
    /// "a canonical owner.json also readable by the Rust side round-trips through readOwner"
    /// parses this exact same literal string, so a record either side writes is provably
    /// readable by the other: `at` especially must stay a plain integer token (no decimal
    /// point), since this struct declares it `u64`.
    const CROSS_LANGUAGE_OWNER_FIXTURE: &str =
        "{\n  \"schema\": 1,\n  \"owner\": \"cli\",\n  \"executable\": \"/usr/local/bin/pacer\",\n  \"at\": 1700000000\n}\n";

    #[test]
    fn cross_language_fixture_matching_the_typescript_side_parses() {
        let dir = TempDir::new();
        fs::write(owner_path(&dir.0), CROSS_LANGUAGE_OWNER_FIXTURE).unwrap();
        let record = read_owner(&dir.0).unwrap();
        assert_eq!(record, OwnerRecord { schema: 1, owner: "cli".into(), executable: "/usr/local/bin/pacer".into(), at: 1_700_000_000 });
    }

    #[test]
    fn claim_desktop_ownership_writes_an_unconditional_desktop_record() {
        let dir = TempDir::new();
        let now = SystemTime::now();
        let bundled = Path::new("/Applications/pacer.app/Contents/Resources/pacer");
        // Even over an existing cli record: the desktop's consent/takeover IS the authorization.
        write_owner(&dir.0, "cli", Path::new("/usr/local/bin/pacer"), now).unwrap();
        claim_desktop_ownership(&dir.0, bundled, now).unwrap();
        let record = read_owner(&dir.0).unwrap();
        assert_eq!(record.owner, "desktop");
        assert_eq!(record.executable, bundled.to_string_lossy());
    }
}
