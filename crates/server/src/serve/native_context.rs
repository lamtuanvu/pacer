//! Signed paired-app startup and generation-bound descriptor ownership.
use super::{
    native_bundle::NativeBundle, native_listener::NativeListener, native_trust::NativeTrust,
};
use std::{
    io,
    os::{fd::OwnedFd, unix::net::UnixStream},
    path::Path,
    sync::Arc,
};
use tokio::{
    process::{Child, Command},
    sync::Notify,
    task::JoinHandle,
};

pub struct NativeContext {
    trust: NativeTrust,
    bundle: NativeBundle,
    listener: NativeListener,
    bootstrap: String,
    home: std::path::PathBuf,
    user_home: std::path::PathBuf,
    port: u16,
    stop: Arc<Notify>,
    helper_slots: Arc<tokio::sync::Semaphore>,
}
impl NativeContext {
    pub fn prepare(
        home: &Path,
        port: u16,
        core: &[String],
        version: &str,
        argv: &[String],
    ) -> io::Result<Option<Arc<Self>>> {
        let Some(trust) = NativeTrust::compiled()? else {
            return Ok(None);
        };
        let bundle = NativeBundle::verified(&trust, version)?;
        if core.len() != 1 || Path::new(&core[0]) != bundle.core {
            return Err(denied());
        }
        let bootstrap = bootstrap(&bundle.front, version, argv, port)?;
        let listener = NativeListener::bind(home, port, &bundle.owner)?;
        Ok(Some(Arc::new(Self {
            trust,
            bundle,
            listener,
            bootstrap,
            home: home.canonicalize()?,
            user_home: std::env::var_os("HOME")
                .map(std::path::PathBuf::from)
                .ok_or_else(denied)?,
            port,
            stop: Arc::new(Notify::new()),
            helper_slots: Arc::new(tokio::sync::Semaphore::new(4)),
        })))
    }
    pub async fn shutdown_requested(&self) {
        self.stop.notified().await;
    }
    pub fn start(&self, command: &mut Command) -> io::Result<(Child, JoinHandle<()>)> {
        use std::process::Stdio;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        let (parent, child_input) = UnixStream::pair()?;
        socket2::SockRef::from(&parent).set_nosigpipe(true)?;
        let input: OwnedFd = child_input.into();
        command
            .env("PACER_INTERNAL_NATIVE_BOOTSTRAP", &self.bootstrap)
            .stdin(Stdio::from(input));
        let child = command.spawn()?;
        // Only a currently owned, unreaped, signed child gets native admission.
        let generation = self.trust.verify_child(&child, &self.bundle.core)?;
        let (helpers, remote) = UnixStream::pair()?;
        socket2::SockRef::from(&helpers).set_nosigpipe(true)?;
        super::native_bootstrap::send(&parent, self.listener.listener(), &remote)?;
        let broker = super::native_helper::Broker {
            trust: self.trust.clone(),
            home: self.home.clone(),
            user_home: self.user_home.clone(),
            port: self.port,
            root: self.bundle.owner.clone(),
            front: self.bundle.front.clone(),
            generation,
            slots: self.helper_slots.clone(),
        };
        let control = super::native_bootstrap::monitor(
            parent,
            remote,
            broker.run(helpers),
            self.stop.clone(),
            deadline,
        )?;
        Ok((child, control))
    }
}
fn denied() -> io::Error {
    io::Error::other("native paired startup unavailable")
}
fn bootstrap(front: &Path, version: &str, argv: &[String], port: u16) -> io::Result<String> {
    let front = front.to_str().ok_or_else(denied)?;
    if version.is_empty()
        || port == 0
        || argv.first().map(String::as_str) != Some(front)
        || argv.get(1).map(String::as_str) != Some("serve")
        || !(argv.len() == 2
            || argv.len() == 4
                && argv[2] == "--port"
                && (argv[3] == port.to_string() || argv[3] == "0"))
    {
        return Err(denied());
    }
    Ok(serde_json::json!({"schema":1,"argv":argv,"frontVersion":version}).to_string())
}
#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    #[test]
    fn bootstrap_binds_exact_front_version_argv_and_bound_port() {
        let front = Path::new("/Applications/Pacer.app/Contents/Resources/pacer");
        let argv = vec![
            front.to_string_lossy().into_owned(),
            "serve".into(),
            "--port".into(),
            "4317".into(),
        ];
        assert!(bootstrap(front, "0.8.0", &argv, 4317).is_ok());
        assert!(bootstrap(front, "", &argv, 4317).is_err());
        assert!(bootstrap(front, "0.8.0", &argv, 0).is_err());
        assert!(bootstrap(front, "0.8.0", &argv, 4318).is_err());
        assert!(bootstrap(Path::new("/other/pacer"), "0.8.0", &argv, 4317).is_err());
        let mut injected = argv;
        injected.push("--internal".into());
        assert!(bootstrap(front, "0.8.0", &injected, 4317).is_err());
    }
    #[test]
    fn ephemeral_launch_intent_preserves_zero_without_claiming_a_zero_listener() {
        let front = Path::new("/Applications/Pacer.app/Contents/Resources/pacer");
        let mut argv = vec![
            front.to_string_lossy().into_owned(),
            "serve".into(),
            "--port".into(),
            "0".into(),
        ];
        let value: serde_json::Value =
            serde_json::from_str(&bootstrap(front, "0.8.0", &argv, 4317).unwrap()).unwrap();
        assert_eq!(value["argv"][3], "0");
        assert!(bootstrap(front, "0.8.0", &argv, 0).is_err());
        for port in ["00", "+0", "4318"] {
            argv[3] = port.into();
            assert!(bootstrap(front, "0.8.0", &argv, 4317).is_err());
        }
    }
}
