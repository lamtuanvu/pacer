//! Signed paired-app startup and generation-bound descriptor ownership.
use super::{
    native_bundle::NativeBundle, native_listener::NativeListener, native_trust::NativeTrust,
};
use std::{
    io,
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::net::UnixStream,
    },
    path::Path,
    sync::Arc,
};
use tokio::{
    io::AsyncReadExt,
    process::{Child, Command},
    sync::Notify,
    task::JoinHandle,
};

pub struct NativeContext {
    trust: NativeTrust,
    bundle: NativeBundle,
    listener: NativeListener,
    bootstrap: String,
    stop: Arc<Notify>,
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
            stop: Arc::new(Notify::new()),
        })))
    }
    pub async fn shutdown_requested(&self) {
        self.stop.notified().await;
    }
    pub fn start(&self, command: &mut Command) -> io::Result<(Child, JoinHandle<()>)> {
        use nix::sys::socket::{ControlMessage, MsgFlags, UnixAddr, sendmsg};
        use std::{io::IoSlice, process::Stdio};
        let (parent, child_input) = UnixStream::pair()?;
        socket2::SockRef::from(&parent).set_nosigpipe(true)?;
        let input: OwnedFd = child_input.into();
        command
            .env("PACER_INTERNAL_NATIVE_BOOTSTRAP", &self.bootstrap)
            .stdin(Stdio::from(input));
        let child = command.spawn()?;
        // Only a currently owned, unreaped, signed child gets native admission.
        self.trust.verify_child(&child, &self.bundle.core)?;
        let descriptors = [self.listener.listener().as_raw_fd()];
        let bytes = sendmsg::<UnixAddr>(
            parent.as_raw_fd(),
            &[IoSlice::new(b"P")],
            &[ControlMessage::ScmRights(&descriptors)],
            MsgFlags::empty(),
            None,
        )?;
        if bytes != 1 {
            return Err(denied());
        }
        let control = monitor(parent, self.stop.clone())?;
        Ok((child, control))
    }
}
fn monitor(parent: UnixStream, stop: Arc<Notify>) -> io::Result<JoinHandle<()>> {
    parent.set_nonblocking(true)?;
    let mut channel = tokio::net::UnixStream::from_std(parent)?;
    Ok(tokio::spawn(async move {
        let mut request = [0u8; 1];
        if matches!(channel.read(&mut request).await, Ok(1)) && request == *b"S" {
            stop.notify_one();
        }
        // EOF, malformed requests, or generation retirement drop the channel.
        // The core's existing stdin EOF watcher then stops that generation.
    }))
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
            || argv.len() == 4 && argv[2] == "--port" && argv[3] == port.to_string())
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
    #[tokio::test]
    async fn control_accepts_only_fixed_shutdown_and_closes_retired_generation() {
        use std::io::{Read, Write};
        for request in [Some(b'S'), Some(b'X'), None] {
            let (parent, mut child) = UnixStream::pair().unwrap();
            let stop = Arc::new(Notify::new());
            let task = monitor(parent, stop.clone()).unwrap();
            if let Some(byte) = request {
                child.write_all(&[byte]).unwrap();
            } else {
                child.shutdown(std::net::Shutdown::Write).unwrap();
            }
            tokio::time::timeout(std::time::Duration::from_secs(1), task)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                tokio::time::timeout(std::time::Duration::from_millis(10), stop.notified())
                    .await
                    .is_ok(),
                request == Some(b'S')
            );
            let mut byte = [0];
            assert_eq!(child.read(&mut byte).unwrap(), 0);
        }
    }
}
