//! Pairing hand-over only: net.p2p remains declarative, as in the TypeScript host.
use crate::BrokerError;
use serde_json::{Value, json};
use std::{
    future::Future,
    time::{Duration, Instant},
};

pub struct PairingCandidate {
    pub id: String,
    pub enabled: bool,
    pub pairing: bool,
}
pub trait PairingRegistry {
    fn start(
        &mut self,
        id: &str,
        params: Value,
        budget: Duration,
    ) -> impl Future<Output = Result<Value, BrokerError>>;
    fn log(&mut self, id: &str, message: &str);
}
pub async fn handover_pairing<R: PairingRegistry>(
    candidates: &[PairingCandidate],
    seen: Value,
    registry: &mut R,
    budget: Duration,
) -> Value {
    let end = Instant::now() + budget;
    for candidate in candidates.iter().filter(|p| p.enabled && p.pairing) {
        let Some(left) = end
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
        else {
            break;
        };
        let result = tokio::time::timeout(
            left,
            registry.start(&candidate.id, json!({"discoveryId":seen["discoveryId"],"name":seen["name"],"hints":seen["hints"]}), left),
        )
        .await;
        match result {
            Ok(Ok(reply)) => match reply.get("accepted").and_then(Value::as_bool) {
                Some(true) => return json!({"handedOver":true,"plugin":candidate.id}),
                Some(false) => {}
                None => registry.log(&candidate.id, "invalid pairing.start result: accepted"),
            },
            Ok(Err(error)) => {
                registry.log(&candidate.id, &format!("pairing.start failed: {error}"))
            }
            Err(_) => registry.log(
                &candidate.id,
                "pairing.start failed: hand-over time budget used up",
            ),
        }
    }
    json!({"handedOver":false})
}

/// Pair hand-over and its private durable receipt. The seen record is looked up
/// again under the discovery lock so radio updates are never overwritten.
pub async fn pair<R: PairingRegistry>(
    home: &std::path::Path,
    candidates: &[PairingCandidate],
    seen: Value,
    registry: &mut R,
    budget: Duration,
    now: f64,
    read_only: bool,
) -> Result<Value, BrokerError> {
    let result = handover_pairing(candidates, seen.clone(), registry, budget).await;
    if result["handedOver"] == true {
        if read_only {
            return Err(crate::AuthorityError::Denied("pacer is read-only here".into()).into());
        }
        record_pairing(
            home,
            seen["discoveryId"]
                .as_str()
                .ok_or(BrokerError::Invalid("discovery id"))?,
            now,
        )
        .await?;
    }
    Ok(result)
}
async fn record_pairing(
    home: &std::path::Path,
    discovery_id: &str,
    now: f64,
) -> Result<(), BrokerError> {
    use crate::{NativeWrite, WriteResource};
    use std::{
        fs::{self, OpenOptions},
        os::unix::fs::{MetadataExt, OpenOptionsExt},
    };
    let failed = || BrokerError::Effect("The discovery state file could not be read".into());
    for name in ["orca", "discovery"] {
        let path = home.join(name).to_string_lossy().into_owned();
        NativeWrite::prepare(
            home,
            &[WriteResource {
                path: path.clone(),
                kind: "directory".into(),
                operations: vec!["mkdir".into()],
            }],
        )?
        .answer("capability.fs.mkdir", &json!({"path":path}))?;
    }
    let lock = home.join("orca/discovery.lock");
    let end = Instant::now() + Duration::from_secs(20);
    let descriptor = loop {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&lock)
        {
            Ok(file) => break file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && Instant::now() < end => {
                tokio::time::sleep(Duration::from_millis(50)).await
            }
            Err(_) => return Err(failed()),
        }
    };
    struct Lock(std::path::PathBuf, std::fs::File);
    impl Drop for Lock {
        fn drop(&mut self) {
            if fs::symlink_metadata(&self.0)
                .ok()
                .zip(self.1.metadata().ok())
                .is_some_and(|(a, b)| a.ino() == b.ino() && a.dev() == b.dev())
            {
                let _ = fs::remove_file(&self.0);
            }
        }
    }
    let _lock = Lock(lock, descriptor);
    let path = home
        .join("discovery/state.json")
        .to_string_lossy()
        .into_owned();
    let mut writer = NativeWrite::prepare(
        home,
        &[WriteResource {
            path: path.clone(),
            kind: "file".into(),
            operations: vec!["write".into()],
        }],
    )?;
    let mut state = json!({"rev":0,"networksRev":0,"enabled":true,"networks":{},"silenced":{},"seen":{},"prompts":[]});
    match fs::read(&path) {
        Ok(bytes) => {
            let value: Value = serde_json::from_slice(&bytes).map_err(|_| failed())?;
            let values = value.as_object().ok_or_else(failed)?;
            for (key, value) in values {
                if key != "corrupt" {
                    state[key] = value.clone();
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(failed()),
    }
    if let Some(entry) = state
        .get_mut("seen")
        .and_then(Value::as_object_mut)
        .and_then(|s| s.get_mut(discovery_id))
    {
        entry
            .as_object_mut()
            .ok_or_else(failed)?
            .insert("handedOverAt".into(), json!(now));
    }
    state["rev"] = json!(state["rev"].as_f64().ok_or_else(failed)? + 1.0);
    let text = serde_json::to_string_pretty(&state).map_err(|_| failed())? + "\n";
    writer.write_bytes(&path, text.as_bytes())?;
    Ok(())
}
