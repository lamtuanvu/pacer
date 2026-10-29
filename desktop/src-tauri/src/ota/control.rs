//! Private native control. Public HTTP registration and webview input never grant authority.
use super::{
    native,
    trust::{CodeRole, ReleaseTrust},
    ExpectedReadiness, OtaError, ProcessIdentity, ReadinessObservation, ReadinessProof,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    os::unix::{
        io::{AsRawFd, FromRawFd},
        net::UnixStream,
    },
    path::{Path, PathBuf},
};

#[path = "control_adoption.rs"]
mod adoption;
#[path = "control_deadline.rs"]
mod deadline;
pub use adoption::*;

const MAX_FRAME: usize = 262_144;
const LAUNCH_FD: i32 = 3;
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchTicket {
    pub schema: u32,
    pub installation_id: String,
    pub transaction_id: String,
    pub launch_id: String,
    pub native_session_id: String,
    pub nonce: String,
    pub service: ProcessIdentity,
    pub service_version: String,
    pub desktop_version: String,
    pub protocol: u64,
}
impl LaunchTicket {
    pub fn validate(&self) -> Result<(), OtaError> {
        if self.schema != 1
            || self.protocol != 3
            || !valid_nonce(&self.nonce)
            || self.launch_id != self.nonce
            || [
                &self.installation_id,
                &self.transaction_id,
                &self.launch_id,
                &self.native_session_id,
            ]
            .iter()
            .any(|s| !identifier(s))
            || self.service.pid == 0
            || self.service.birth.is_empty()
            || self.service.boot_id.is_empty()
            || self.desktop_version.is_empty()
            || self.service_version.is_empty()
        {
            return Err(OtaError::Invalid);
        }
        Ok(())
    }
}
fn verify_shutdown_receipt(
    value: &serde_json::Value,
    expected: Option<&str>,
) -> Result<(), OtaError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Receipt {
        schema: u32,
        kind: String,
        effect_id: String,
    }
    let receipt: Receipt = serde_json::from_value(value.clone()).map_err(|_| OtaError::Invalid)?;
    if receipt.schema != 1
        || receipt.kind != "effect-accepted"
        || expected != Some(receipt.effect_id.as_str())
    {
        return Err(OtaError::Identity);
    }
    Ok(())
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn valid_nonce(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
pub fn random_nonce() -> Result<String, OtaError> {
    let mut bytes = [0u8; 32];
    if unsafe { libc::getentropy(bytes.as_mut_ptr().cast(), bytes.len()) } != 0 {
        return Err(OtaError::Io);
    }
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
pub fn socket_path(home: &Path, port: u16, uid: u32) -> Result<PathBuf, OtaError> {
    let canonical = home.canonicalize().map_err(|_| OtaError::Identity)?;
    let hash = Sha256::digest(format!("{}\n{port}\n{uid}", canonical.display()).as_bytes());
    let key: String = hash.iter().map(|b| format!("{b:02x}")).collect();
    Ok(PathBuf::from(format!(
        "/private/tmp/pacer-native-{uid}/{}.sock",
        &key[..32]
    )))
}
pub fn write_frame<T: Serialize>(stream: &mut UnixStream, value: &T) -> Result<(), OtaError> {
    let bytes = serde_json::to_vec(value).map_err(|_| OtaError::Invalid)?;
    if bytes.is_empty() || bytes.len() > MAX_FRAME {
        return Err(OtaError::Invalid);
    }
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .and_then(|_| stream.write_all(&bytes))
        .map_err(|_| OtaError::Io)
}
pub fn read_frame<T: serde::de::DeserializeOwned>(stream: &mut UnixStream) -> Result<T, OtaError> {
    let mut length = [0u8; 4];
    stream.read_exact(&mut length).map_err(|_| OtaError::Io)?;
    let n = u32::from_be_bytes(length) as usize;
    if n == 0 || n > MAX_FRAME {
        return Err(OtaError::Invalid);
    }
    let mut bytes = vec![0; n];
    stream.read_exact(&mut bytes).map_err(|_| OtaError::Io)?;
    serde_json::from_slice(&bytes).map_err(|_| OtaError::Invalid)
}
fn write_frame_until<T: Serialize>(
    stream: &mut UnixStream,
    value: &T,
    until: Option<std::time::Instant>,
) -> Result<(), OtaError> {
    let Some(until) = until else {
        return write_frame(stream, value);
    };
    let bytes = serde_json::to_vec(value).map_err(|_| OtaError::Invalid)?;
    if bytes.is_empty() || bytes.len() > MAX_FRAME {
        return Err(OtaError::Invalid);
    }
    deadline::write_all(stream, &(bytes.len() as u32).to_be_bytes(), until)?;
    deadline::write_all(stream, &bytes, until)
}
fn read_frame_until<T: serde::de::DeserializeOwned>(
    stream: &mut UnixStream,
    until: Option<std::time::Instant>,
) -> Result<T, OtaError> {
    let Some(until) = until else {
        return read_frame(stream);
    };
    let mut length = [0u8; 4];
    deadline::read_exact(stream, &mut length, until)?;
    let size = u32::from_be_bytes(length) as usize;
    if size == 0 || size > MAX_FRAME {
        return Err(OtaError::Invalid);
    }
    let mut bytes = vec![0; size];
    deadline::read_exact(stream, &mut bytes, until)?;
    let value = serde_json::from_slice(&bytes).map_err(|_| OtaError::Invalid)?;
    deadline::remaining(until)?;
    Ok(value)
}
#[cfg(target_os = "macos")]
pub fn peer_token(stream: &UnixStream) -> Result<[u8; 32], OtaError> {
    let mut token = [0u8; 32];
    let mut size = 32u32;
    if unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            0,
            6,
            token.as_mut_ptr().cast(),
            &mut size,
        )
    } != 0
        || size != 32
    {
        return Err(OtaError::Identity);
    }
    Ok(token)
}
#[cfg(not(target_os = "macos"))]
pub fn peer_token(_stream: &UnixStream) -> Result<[u8; 32], OtaError> {
    Err(OtaError::Unavailable)
}
fn token_process(token: &[u8; 32]) -> Result<ProcessIdentity, OtaError> {
    let pid = u32::from_ne_bytes(token[20..24].try_into().unwrap());
    native::process_details(pid)
        .map_err(|_| OtaError::Identity)?
        .map(|d| d.identity)
        .ok_or(OtaError::Identity)
}
/// FD3 is capability delivery only. The sender must keep its endpoint open until
/// fresh-channel observation: macOS drops peer credentials when it closes, even
/// with buffered data. Helper authenticates ACK on a FRESH connection.
pub fn read_launch_ticket(trust: &ReleaseTrust) -> Result<Option<LaunchTicket>, OtaError> {
    if unsafe { libc::fcntl(LAUNCH_FD, libc::F_GETFD) } < 0 {
        return Ok(None);
    }
    let duplicate = unsafe { libc::dup(LAUNCH_FD) };
    if duplicate < 0 {
        return Err(OtaError::Io);
    }
    let mut stream = unsafe { UnixStream::from_raw_fd(duplicate) };
    let token = match peer_token(&stream) {
        Ok(t) => t,
        Err(_) => return Ok(None),
    };
    trust.verify_peer(&token_process(&token)?, CodeRole::Helper, &token)?;
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(10)))
        .map_err(|_| OtaError::Io)?;
    let ticket: LaunchTicket = read_frame(&mut stream)?;
    ticket.validate()?;
    unsafe {
        libc::close(LAUNCH_FD);
    };
    Ok(Some(ticket))
}
/// Called by verified helper before spawning/handing off. Never treat this write
/// or a response on this inherited pair as proof of the candidate desktop PID.
pub fn send_launch_ticket(stream: &mut UnixStream, ticket: &LaunchTicket) -> Result<(), OtaError> {
    ticket.validate()?;
    write_frame(stream, ticket)
}

#[derive(Default)]
pub struct NavigationState {
    ticket: Option<LaunchTicket>,
    generation: u64,
    pending: Option<(String, String)>,
    ready: Option<ReadinessProof>,
}
impl NavigationState {
    pub fn with_ticket(ticket: Option<LaunchTicket>) -> Result<Self, OtaError> {
        if let Some(t) = &ticket {
            t.validate()?;
        }
        Ok(Self {
            ticket,
            ..Self::default()
        })
    }
    pub fn maintenance_active(&self) -> bool {
        self.ticket.is_some()
    }
    pub fn ticket(&self) -> Option<&LaunchTicket> {
        self.ticket.as_ref()
    }
    pub fn begin_navigation(&mut self, origin: &str) -> Result<String, OtaError> {
        let url = url::Url::parse(origin).map_err(|_| OtaError::Identity)?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.port().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || url.origin().ascii_serialization() != origin
        {
            return Err(OtaError::Identity);
        }
        self.generation = self.generation.checked_add(1).ok_or(OtaError::Invalid)?;
        self.ready = None;
        let nonce = random_nonce()?;
        self.pending = Some((origin.into(), nonce.clone()));
        Ok(nonce)
    }
    pub fn invalidate(&mut self) {
        self.pending = None;
        self.ready = None;
    }
    /// Authenticated service identity and state read must be established in native
    /// code. The webview supplies only its per-navigation nonce and current origin.
    pub fn document_ready(
        &mut self,
        origin: &str,
        nonce: &str,
        desktop: &ProcessIdentity,
        service: &ProcessIdentity,
        session_id: &str,
        desktop_version: &str,
        service_version: &str,
        protocol: u64,
        valid_state_read: bool,
    ) -> Result<Option<ReadinessProof>, OtaError> {
        if self.pending.as_ref() != Some(&(origin.into(), nonce.into())) || !valid_state_read {
            return Err(OtaError::Identity);
        }
        let Some(ticket) = &self.ticket else {
            self.pending = None;
            return Ok(None);
        };
        if service != &ticket.service
            || session_id != ticket.native_session_id
            || desktop_version != ticket.desktop_version
            || service_version != ticket.service_version
            || protocol != ticket.protocol
            || desktop.boot_id != service.boot_id
        {
            return Err(OtaError::Identity);
        }
        let proof = ReadinessProof {
            installation_id: ticket.installation_id.clone(),
            transaction_id: ticket.transaction_id.clone(),
            desktop: desktop.clone(),
            native_session_id: session_id.into(),
            desktop_version: desktop_version.into(),
            service: service.clone(),
            service_version: service_version.into(),
            protocol,
            desktop_signed_in: true,
            valid_state_read: true,
        };
        self.pending = None;
        self.ready = Some(proof.clone());
        Ok(Some(proof))
    }
}
/// Exact matching applies after the control transport has authenticated the peer
/// and bound its proof to the journal's fresh launch nonce and process incarnation.
pub fn match_readiness(
    expected: &ExpectedReadiness,
    proof: ReadinessProof,
) -> ReadinessObservation {
    if proof.installation_id == expected.installation_id
        && proof.transaction_id == expected.transaction_id
        && proof.desktop == expected.desktop.process
        && proof.native_session_id == expected.desktop.native_session_id
        && proof.desktop_version == expected.desktop.version
        && proof.service == expected.service
        && proof.service_version == expected.service_version
        && proof.protocol == expected.protocol
        && proof.desktop_signed_in
        && proof.valid_state_read
    {
        ReadinessObservation::Ready(proof)
    } else {
        ReadinessObservation::Failed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_open_reports_a_closed_peer_without_consuming_data() {
        use std::io::{Read, Write};
        let (ours, mut theirs) = UnixStream::pair().unwrap();
        assert!(channel_open(&ours));
        theirs.write_all(b"x").unwrap();
        assert!(channel_open(&ours));
        let mut byte = [0u8; 1];
        (&ours).read_exact(&mut byte).unwrap();
        assert_eq!(&byte, b"x");
        drop(theirs);
        assert!(!channel_open(&ours));
    }

    #[test]
    fn takeover_registration_uses_the_inspection_registration_directory() {
        let home = Path::new("/fixture/home");
        let fixture = Path::new("/fixture/ota/registrations");
        assert_eq!(service_registration_path(home, "com.pacer.live.test.service", Some(fixture)), fixture.join("com.pacer.live.test.service.plist"));
        assert_eq!(service_registration_path(home, "com.pacer.serve", None), home.join("Library/LaunchAgents/com.pacer.serve.plist"));
    }
    #[test]
    fn handshake_retries_only_transient_refusals_within_its_deadline() {
        let later = std::time::Instant::now() + std::time::Duration::from_secs(60);
        let mut calls = 0;
        let ok = retry_handshake(
            later,
            || {},
            || {
                calls += 1;
                if calls < 3 {
                    Err(OtaError::Io)
                } else {
                    Ok(calls)
                }
            },
        );
        assert_eq!((ok, calls), (Ok(3), 3));
        calls = 0;
        let refused: Result<(), _> = retry_handshake(
            later,
            || {},
            || {
                calls += 1;
                Err(OtaError::Identity)
            },
        );
        assert_eq!((refused, calls), (Err(OtaError::Identity), 1));
        calls = 0;
        let expired: Result<(), _> = retry_handshake(
            std::time::Instant::now(),
            || {},
            || {
                calls += 1;
                Err(if calls == 1 {
                    OtaError::Unavailable
                } else {
                    OtaError::Io
                })
            },
        );
        assert_eq!((expired, calls), (Err(OtaError::Unavailable), 1));
    }
    #[test]
    fn adoption_context_deadline_preserves_invalid_frame_refusal() {
        for payload in [b"{".as_slice(), b"null".as_slice()] {
            let (mut client, mut server) = UnixStream::pair().unwrap();
            server
                .write_all(&(payload.len() as u32).to_be_bytes())
                .unwrap();
            server.write_all(payload).unwrap();
            let result: Result<ControlSession, _> = read_frame_until(
                &mut client,
                Some(std::time::Instant::now() + HANDSHAKE_RETRY),
            );
            assert!(matches!(result, Err(OtaError::Invalid)));
        }
        for length in [0, MAX_FRAME + 1] {
            let (mut client, mut server) = UnixStream::pair().unwrap();
            server.write_all(&(length as u32).to_be_bytes()).unwrap();
            let result: Result<ControlSession, _> = read_frame_until(
                &mut client,
                Some(std::time::Instant::now() + HANDSHAKE_RETRY),
            );
            assert!(matches!(result, Err(OtaError::Invalid)));
        }
    }
    #[test]
    fn shutdown_requires_receipt_for_the_exact_pending_effect() {
        let receipt =
            serde_json::json!({"schema":1,"kind":"effect-accepted","effectId":"shutdown-one"});
        assert!(verify_shutdown_receipt(&receipt, Some("shutdown-one")).is_ok());
        assert!(verify_shutdown_receipt(&receipt, None).is_err());
        assert!(verify_shutdown_receipt(&receipt, Some("another")).is_err());
        let mut changed = receipt;
        changed["unexpected"] = serde_json::json!(true);
        assert!(verify_shutdown_receipt(&changed, Some("shutdown-one")).is_err());
    }
    fn process(pid: u32) -> ProcessIdentity {
        ProcessIdentity {
            pid,
            boot_id: "boot".into(),
            birth: format!("{pid}:1"),
        }
    }
    fn ticket() -> LaunchTicket {
        LaunchTicket {
            schema: 1,
            installation_id: "installation".into(),
            transaction_id: "transaction".into(),
            launch_id: "a".repeat(64),
            native_session_id: "session".into(),
            nonce: "a".repeat(64),
            service: process(2),
            service_version: "1.0.0".into(),
            desktop_version: "1.0.0".into(),
            protocol: 3,
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn inherited_socketpair_identifies_creator_but_fresh_socket_identifies_child() {
        use std::os::unix::net::UnixListener;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("peer.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let (mut parent, child) = UnixStream::pair().unwrap();
        parent
            .set_read_timeout(Some(std::time::Duration::from_secs(3)))
            .unwrap();
        let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
        address.sun_family = libc::AF_UNIX as u8;
        let name = path.as_os_str().as_encoded_bytes();
        assert!(name.len() < 104);
        for (i, b) in name.iter().enumerate() {
            address.sun_path[i] = *b as i8;
        }
        address.sun_len = (name.len() + 3) as u8;
        let creator = std::process::id();
        let initial = peer_token(&parent).unwrap();
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0);
        if pid == 0 {
            // Only async-signal-safe syscalls after fork in the test process.
            let mut token = [0u8; 32];
            let mut n = 32u32;
            unsafe {
                if libc::getsockopt(child.as_raw_fd(), 0, 6, token.as_mut_ptr().cast(), &mut n) != 0
                {
                    libc::_exit(2);
                }
                libc::write(child.as_raw_fd(), token.as_ptr().cast(), 32);
                let fd = libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0);
                if libc::connect(
                    fd,
                    (&address as *const libc::sockaddr_un).cast(),
                    u32::from(address.sun_len),
                ) != 0
                {
                    libc::_exit(3);
                }
                libc::write(fd, b"x".as_ptr().cast(), 1);
                let mut ack = [0u8; 1];
                libc::read(fd, ack.as_mut_ptr().cast(), 1);
                libc::close(fd);
                libc::_exit(0);
            }
        }
        drop(child);
        let mut inherited = [0u8; 32];
        parent.read_exact(&mut inherited).unwrap();
        let (mut fresh, _) = listener.accept().unwrap();
        let observed = peer_token(&fresh).unwrap();
        let inherited_after_write =
            u32::from_ne_bytes(peer_token(&parent).unwrap()[20..24].try_into().unwrap());
        fresh.write_all(b"y").unwrap();
        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
        assert_eq!(status, 0);
        assert_eq!(
            u32::from_ne_bytes(initial[20..24].try_into().unwrap()),
            creator
        );
        assert_eq!(
            u32::from_ne_bytes(inherited[20..24].try_into().unwrap()),
            creator
        );
        assert!([creator, pid as u32].contains(&inherited_after_write));
        assert_eq!(
            u32::from_ne_bytes(observed[20..24].try_into().unwrap()),
            pid as u32
        );
    }
    #[test]
    fn native_registration_requires_exact_home_port_and_standalone_argv() {
        let text = r#"<plist><dict><key>Label</key><string>com.pacer.serve</string><key>ProgramArguments</key><array><string>/opt/pacer</string><string>serve</string></array><key>EnvironmentVariables</key><dict><key>HOME</key><string>/tmp/user</string><key>PACER_HOME</key><string>/tmp/state</string><key>PACER_PORT</key><string>7433</string></dict></dict></plist>"#;
        let argv = parse_registration(
            text.as_bytes(),
            Path::new("/tmp/user"),
            Path::new("/tmp/state"),
            7433,
            "com.pacer.serve",
        )
        .unwrap();
        assert_eq!(argv, vec!["/opt/pacer", "serve"]);
        assert!(parse_registration(
            text.as_bytes(),
            Path::new("/tmp/user"),
            Path::new("/tmp/state"),
            7434,
            "com.pacer.serve"
        )
        .is_err());
        assert!(parse_registration(
            text.replace(
                "<string>serve</string>",
                "<string>script.ts</string><string>serve</string>"
            )
            .as_bytes(),
            Path::new("/tmp/user"),
            Path::new("/tmp/state"),
            7433,
            "com.pacer.serve"
        )
        .is_err());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn ordinary_bootstrap_refuses_redirected_maintenance_directory() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        ordinary_maintenance_clear(&home).unwrap();
        let elsewhere = home.join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        std::fs::set_permissions(&elsewhere, std::fs::Permissions::from_mode(0o700)).unwrap();
        symlink(&elsewhere, home.join("desktop-updates")).unwrap();
        assert!(ordinary_maintenance_clear(&home).is_err());
    }
    #[test]
    fn ordinary_lifecycle_never_replaces_attached_or_restarts_running_service() {
        use super::super::platform::{JobChange, LoadedJob};
        let bundled = Path::new("/tmp/pacer.app/Contents/Resources/pacer");
        assert!(managed_action("install", Some(Path::new("/opt/pacer")), bundled, None).is_err());
        assert!(managed_action(
            "restart",
            Some(bundled),
            bundled,
            Some(&LoadedJob {
                pid: Some(42),
                disabled: None
            })
        )
        .is_err());
        assert_eq!(
            managed_action("install", None, bundled, None).unwrap(),
            JobChange::Bootstrap
        );
        assert!(managed_action(
            "install",
            None,
            bundled,
            Some(&LoadedJob {
                pid: None,
                disabled: None
            })
        )
        .is_err());
        assert_eq!(
            managed_action(
                "start",
                Some(bundled),
                bundled,
                Some(&LoadedJob {
                    pid: None,
                    disabled: None
                })
            )
            .unwrap(),
            JobChange::Kickstart
        );
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn native_process_inventory_contains_exact_own_incarnation() {
        let own = native::process_details(std::process::id())
            .unwrap()
            .unwrap();
        assert!(native_process_inventory()
            .unwrap()
            .iter()
            .any(|p| p == &own));
    }
    #[test]
    fn control_ack_binds_exact_command_and_effect() {
        let binding = super::super::wire::Binding {
            schema: 1,
            command_id: "command".into(),
            installation_id: "installation".into(),
            transaction_id: Some("transaction".into()),
            revision: 4,
            nonce: "b".repeat(64),
        };
        let ack = ControlAck {
            schema: 1,
            kind: "ack".into(),
            action: "suppress-lifecycle".into(),
            binding: binding.clone(),
        };
        assert!(ack.matches(&binding, "suppress-lifecycle"));
        assert!(!ack.matches(&binding, "shutdown-service"));
        let mut changed = binding.clone();
        changed.nonce = "c".repeat(64);
        assert!(!ack.matches(&changed, "suppress-lifecycle"));
    }
    #[test]
    fn launch_ticket_and_navigation_reject_unbound_capabilities() {
        let mut wrong = ticket();
        wrong.launch_id = "b".repeat(64);
        assert!(wrong.validate().is_err());
        let mut state = NavigationState::default();
        assert!(state
            .begin_navigation("http://127.0.0.1:7433@evil.invalid")
            .is_err());
    }
    #[test]
    fn stale_document_or_forged_service_cannot_acknowledge_launch() {
        let mut state = NavigationState::with_ticket(Some(ticket())).unwrap();
        let old = state.begin_navigation("http://127.0.0.1:7433").unwrap();
        let current = state.begin_navigation("http://127.0.0.1:7433").unwrap();
        assert!(state
            .document_ready(
                "http://127.0.0.1:7433",
                &old,
                &process(1),
                &process(2),
                "session",
                "1.0.0",
                "1.0.0",
                3,
                true
            )
            .is_err());
        assert!(state
            .document_ready(
                "http://127.0.0.1:7433",
                &current,
                &process(1),
                &process(3),
                "session",
                "1.0.0",
                "1.0.0",
                3,
                true
            )
            .is_err());
        assert!(state
            .document_ready(
                "http://127.0.0.1:7433",
                &current,
                &process(1),
                &process(2),
                "session",
                "1.0.0",
                "1.0.0",
                3,
                false
            )
            .is_err());
        assert!(state
            .document_ready(
                "http://127.0.0.1:7433",
                &current,
                &process(1),
                &process(2),
                "session",
                "1.0.0",
                "1.0.0",
                3,
                true
            )
            .unwrap()
            .is_some());
        assert!(state
            .document_ready(
                "http://127.0.0.1:7433",
                &current,
                &process(1),
                &process(2),
                "session",
                "1.0.0",
                "1.0.0",
                3,
                true
            )
            .is_err());
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn buffered_launch_ticket_needs_live_sender_for_peer_authentication() {
        let (mut sender, mut receiver) = UnixStream::pair().unwrap();
        send_launch_ticket(&mut sender, &ticket()).unwrap();
        let token = peer_token(&receiver).unwrap();
        assert_eq!(
            u32::from_ne_bytes(token[20..24].try_into().unwrap()),
            std::process::id()
        );
        assert_eq!(read_frame::<LaunchTicket>(&mut receiver).unwrap(), ticket());
        send_launch_ticket(&mut sender, &ticket()).unwrap();
        drop(sender);
        assert!(peer_token(&receiver).is_err());
        // Buffered bytes alone cannot authenticate the sender after close.
        assert_eq!(read_frame::<LaunchTicket>(&mut receiver).unwrap(), ticket());
    }
    #[test]
    fn ticket_framing_is_bounded_and_maintenance_is_explicit() {
        let (mut a, mut b) = UnixStream::pair().unwrap();
        send_launch_ticket(&mut a, &ticket()).unwrap();
        assert_eq!(read_frame::<LaunchTicket>(&mut b).unwrap(), ticket());
        a.write_all(&u32::MAX.to_be_bytes()).unwrap();
        assert!(read_frame::<LaunchTicket>(&mut b).is_err());
        assert!(!NavigationState::default().maintenance_active());
        assert!(NavigationState::with_ticket(Some(ticket()))
            .unwrap()
            .maintenance_active());
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransactionContext {
    pub reservation_id: String,
    pub journal_sha256: Option<String>,
    pub authorized: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelperContext {
    pub schema: u32,
    pub binding: super::wire::Binding,
    pub target: super::wire::Installation,
    pub native_session_id: String,
    pub desktop: ProcessIdentity,
    pub service: ProcessIdentity,
    pub service_version: String,
    pub service_executable: String,
    pub protocol: u64,
    pub admission_protocol: u64,
    pub state_compatible: bool,
    pub transaction: Option<TransactionContext>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceChallenge {
    pub schema: u32,
    pub kind: String,
    pub nonce: String,
    pub service: ProcessIdentity,
    pub version: String,
    pub port: u16,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlSession {
    pub schema: u32,
    pub kind: String,
    pub nonce: String,
    pub session_id: String,
    pub client_id: String,
    pub service_version: String,
    pub installation: Option<super::wire::Installation>,
}
/// Canonical executable is independently obtained from the verified registration,
/// never chosen by a wire peer or inferred from the port/health response.
pub struct ServiceEndpoint<'a> {
    pub home: &'a Path,
    pub port: u16,
    pub process: &'a ProcessIdentity,
    pub executable: &'a Path,
}
fn authenticate_service(
    endpoint: &ServiceEndpoint<'_>,
    trust: &ReleaseTrust,
    role: &str,
    ticket: Option<&LaunchTicket>,
) -> Result<(UnixStream, ControlSession), OtaError> {
    if role != "helper" {
        return authenticate_service_adoption(endpoint, trust, role, ticket, None);
    }
    retry_handshake(
        std::time::Instant::now() + HANDSHAKE_RETRY,
        || std::thread::sleep(super::OBSERVATION_INTERVAL),
        || authenticate_service_adoption(endpoint, trust, role, ticket, None),
    )
}
const HANDSHAKE_RETRY: std::time::Duration = std::time::Duration::from_secs(10);
/// The service refuses a hello while it cannot account for every pacer process,
/// such as the desktop's short-lived sign-in CLI. That refusal precedes any
/// request frame, so a bounded retry never repeats an effect; a lasting refusal
/// still fails once the deadline passes.
fn retry_handshake<T>(
    deadline: std::time::Instant,
    pause: impl Fn(),
    mut attempt: impl FnMut() -> Result<T, OtaError>,
) -> Result<T, OtaError> {
    loop {
        match attempt() {
            Err(OtaError::Io | OtaError::Unavailable) if std::time::Instant::now() < deadline => {
                pause()
            }
            other => return other,
        }
    }
}
fn authenticate_service_adoption(
    endpoint: &ServiceEndpoint<'_>,
    trust: &ReleaseTrust,
    role: &str,
    ticket: Option<&LaunchTicket>,
    adoption: Option<&AdoptionReconnectPlan>,
) -> Result<(UnixStream, ControlSession), OtaError> {
    authenticate_service_adoption_until(endpoint, trust, role, ticket, adoption, None)
}
fn authenticate_service_adoption_until(
    endpoint: &ServiceEndpoint<'_>,
    trust: &ReleaseTrust,
    role: &str,
    ticket: Option<&LaunchTicket>,
    adoption: Option<&AdoptionReconnectPlan>,
    until: Option<std::time::Instant>,
) -> Result<(UnixStream, ControlSession), OtaError> {
    if let Some(until) = until {
        deadline::remaining(until)?;
    }
    if ticket.is_some() && adoption.is_some() {
        return Err(OtaError::Identity);
    }
    let mut stream = UnixStream::connect(socket_path(endpoint.home, endpoint.port, unsafe {
        libc::getuid()
    })?)
    .map_err(|_| OtaError::Unavailable)?;
    stream
        .set_read_timeout(Some(match until {
            Some(until) => deadline::remaining(until)?,
            None => std::time::Duration::from_secs(10),
        }))
        .map_err(|_| OtaError::Io)?;
    stream
        .set_write_timeout(Some(match until {
            Some(until) => deadline::remaining(until)?,
            None => std::time::Duration::from_secs(10),
        }))
        .map_err(|_| OtaError::Io)?;
    let peer = trust.verify_peer(endpoint.process, CodeRole::Cli, &peer_token(&stream)?)?;
    if peer
        .details()
        .executable
        .canonicalize()
        .map_err(|_| OtaError::Identity)?
        != endpoint
            .executable
            .canonicalize()
            .map_err(|_| OtaError::Identity)?
    {
        return Err(OtaError::Identity);
    }
    let challenge: ServiceChallenge = read_frame_until(&mut stream, until)?;
    if challenge.schema != 1
        || challenge.kind != "challenge"
        || !valid_nonce(&challenge.nonce)
        || challenge.service != *endpoint.process
        || challenge.port != endpoint.port
    {
        return Err(OtaError::Identity);
    }
    let nonce = random_nonce()?;
    let mut hello = serde_json::json!({"schema":1,"kind":"hello","nonce":nonce,"challenge":challenge.nonce,"version":env!("CARGO_PKG_VERSION"),"role":role});
    if let Some(ticket) = ticket {
        ticket.validate()?;
        if ticket.service != *endpoint.process {
            return Err(OtaError::Identity);
        }
        hello["ticket"] = serde_json::to_value(ticket).map_err(|_| OtaError::Invalid)?;
    }
    if let Some(plan) = adoption {
        plan.validate()?;
        hello["adoption"] = serde_json::to_value(plan).map_err(|_| OtaError::Invalid)?;
    }
    write_frame_until(&mut stream, &hello, until)?;
    let session: ControlSession = read_frame_until(&mut stream, until)?;
    if session.schema != 1
        || session.kind != "registered"
        || session.nonce != nonce
        || !identifier(&session.session_id)
        || !identifier(&session.client_id)
    {
        return Err(OtaError::Identity);
    }
    if let Some(until) = until {
        deadline::remaining(until)?;
    }
    Ok((stream, session))
}
/// An authenticated helper channel to a service, with no request sent. The
/// takeover helper holds it as proof of the bundled service's native endpoint.
pub fn authenticate_helper(
    endpoint: &ServiceEndpoint<'_>,
    trust: &ReleaseTrust,
) -> Result<UnixStream, OtaError> {
    authenticate_service(endpoint, trust, "helper", None).map(|(stream, _)| stream)
}
/// Whether the service still holds an authenticated channel open.
pub fn channel_open(stream: &UnixStream) -> bool {
    use std::os::fd::AsRawFd;
    let mut byte = 0u8;
    let read = unsafe {
        libc::recv(
            stream.as_raw_fd(),
            (&mut byte as *mut u8).cast(),
            1,
            libc::MSG_PEEK | libc::MSG_DONTWAIT,
        )
    };
    read > 0 || read < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::WouldBlock
}
/// A helper's stdin target is descriptive only; this authenticated context is the
/// service's independently observed authority. Recovery returns recorded context.
pub fn helper_session(
    endpoint: &ServiceEndpoint<'_>,
    binding: &super::wire::Binding,
    trust: &ReleaseTrust,
) -> Result<HelperContext, OtaError> {
    let (mut stream, session) = authenticate_service(endpoint, trust, "helper", None)?;
    write_frame(
        &mut stream,
        &serde_json::json!({"schema":1,"kind":"helper-context","sessionId":session.session_id,"sequence":1,"binding":binding}),
    )?;
    let context: HelperContext = read_frame(&mut stream)?;
    if context.schema != 1
        || context.binding != *binding
        || context.target.id != binding.installation_id
        || context.service != *endpoint.process
        || context.protocol != 3
        || context.admission_protocol != 1
        || !context.state_compatible
    {
        return Err(OtaError::Identity);
    }
    Ok(context)
}
pub fn query_readiness(
    endpoint: &ServiceEndpoint<'_>,
    expected: &ExpectedReadiness,
    trust: &ReleaseTrust,
) -> Result<ReadinessObservation, OtaError> {
    let (mut stream, session) = authenticate_service(endpoint, trust, "helper", None)?;
    if expected.service != *endpoint.process {
        return Err(OtaError::Identity);
    }
    write_frame(
        &mut stream,
        &serde_json::json!({"schema":1,"kind":"query-readiness","sessionId":session.session_id,"sequence":1,"installationId":expected.installation_id,"transactionId":expected.transaction_id}),
    )?;
    let result: Option<ReadinessProof> = read_frame(&mut stream)?;
    Ok(result.map_or(ReadinessObservation::Pending, |proof| {
        match_readiness(expected, proof)
    }))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlAck {
    pub schema: u32,
    pub kind: String,
    pub action: String,
    pub binding: super::wire::Binding,
}
impl ControlAck {
    fn matches(&self, binding: &super::wire::Binding, action: &str) -> bool {
        self.schema == 1 && self.kind == "ack" && self.action == action && self.binding == *binding
    }
}
fn request_effect(
    endpoint: &ServiceEndpoint<'_>,
    binding: &super::wire::Binding,
    trust: &ReleaseTrust,
    kind: &str,
    expected: Option<&ProcessIdentity>,
) -> Result<(), OtaError> {
    let (mut stream, session) = authenticate_service(endpoint, trust, "helper", None)?;
    write_frame(
        &mut stream,
        &serde_json::json!({"schema":1,"kind":kind,"sessionId":session.session_id,"sequence":1,"binding":binding,"expected":expected}),
    )?;
    let ack: ControlAck = read_frame(&mut stream)?;
    if !ack.matches(binding, kind) {
        return Err(OtaError::Identity);
    }
    Ok(())
}
pub fn suppress_lifecycle(
    endpoint: &ServiceEndpoint<'_>,
    binding: &super::wire::Binding,
    trust: &ReleaseTrust,
) -> Result<(), OtaError> {
    request_effect(endpoint, binding, trust, "suppress-lifecycle", None)
}
pub fn request_service_shutdown(
    endpoint: &ServiceEndpoint<'_>,
    binding: &super::wire::Binding,
    expected: &ProcessIdentity,
    trust: &ReleaseTrust,
) -> Result<(), OtaError> {
    if expected != endpoint.process {
        return Err(OtaError::Identity);
    }
    request_effect(endpoint, binding, trust, "shutdown-service", Some(expected))
}
pub fn request_desktop_shutdown(
    endpoint: &ServiceEndpoint<'_>,
    binding: &super::wire::Binding,
    expected: &ProcessIdentity,
    trust: &ReleaseTrust,
) -> Result<(), OtaError> {
    request_effect(endpoint, binding, trust, "shutdown-desktop", Some(expected))
}
pub fn release_reservation(
    endpoint: &ServiceEndpoint<'_>,
    binding: &super::wire::Binding,
    trust: &ReleaseTrust,
) -> Result<(), OtaError> {
    request_effect(endpoint, binding, trust, "release-reservation", None)
}
pub fn maintenance_context(
    endpoint: &ServiceEndpoint<'_>,
    binding: &super::wire::Binding,
    trust: &ReleaseTrust,
) -> Result<HelperContext, OtaError> {
    helper_session(endpoint, binding, trust)
}
pub fn observe_launch(
    endpoint: &ServiceEndpoint<'_>,
    binding: &super::wire::Binding,
    launch_id: &str,
    trust: &ReleaseTrust,
) -> Result<Option<super::LaunchEvidence>, OtaError> {
    if !valid_nonce(launch_id) {
        return Err(OtaError::Invalid);
    }
    let (mut stream, session) = authenticate_service(endpoint, trust, "helper", None)?;
    write_frame(
        &mut stream,
        &serde_json::json!({"schema":1,"kind":"observe-launch","sessionId":session.session_id,"sequence":1,"binding":binding,"launchId":launch_id}),
    )?;
    let observed: Option<super::LaunchEvidence> = read_frame(&mut stream)?;
    if observed
        .as_ref()
        .is_some_and(|launch| launch.launch_id != launch_id)
    {
        return Err(OtaError::Identity);
    }
    Ok(observed)
}

pub(crate) fn parse_registration(
    bytes: &[u8],
    user_home: &Path,
    home: &Path,
    port: u16,
    label: &str,
) -> Result<Vec<String>, OtaError> {
    let value = plist::Value::from_reader_xml(bytes).map_err(|_| OtaError::Identity)?;
    let data = value.as_dictionary().ok_or(OtaError::Identity)?;
    let allowed = [
        "Label",
        "ProgramArguments",
        "EnvironmentVariables",
        "RunAtLoad",
        "KeepAlive",
        "ThrottleInterval",
        "ProcessType",
        "StandardOutPath",
        "StandardErrorPath",
    ];
    if data.keys().any(|key| !allowed.contains(&key.as_str()))
        || data.get("Label").and_then(plist::Value::as_string) != Some(label)
    {
        return Err(OtaError::Identity);
    }
    let argv = data
        .get("ProgramArguments")
        .and_then(plist::Value::as_array)
        .ok_or(OtaError::Identity)?
        .iter()
        .map(|v| v.as_string().map(str::to_owned).ok_or(OtaError::Identity))
        .collect::<Result<Vec<_>, _>>()?;
    if !matches!(argv.len(), 2 | 4)
        || argv[1] != "serve"
        || !Path::new(&argv[0]).is_absolute()
        || argv.len() == 4 && (argv[2] != "--port" || argv[3] != port.to_string())
    {
        return Err(OtaError::Identity);
    }
    let env = data
        .get("EnvironmentVariables")
        .and_then(plist::Value::as_dictionary)
        .ok_or(OtaError::Identity)?;
    if env
        .keys()
        .any(|key| !["HOME", "PATH", "PACER_HOME", "PACER_PORT"].contains(&key.as_str()))
        || env.get("HOME").and_then(plist::Value::as_string) != user_home.to_str()
        || env.get("PACER_HOME").and_then(plist::Value::as_string) != home.to_str()
        || env
            .get("PACER_PORT")
            .and_then(plist::Value::as_string)
            .unwrap_or("4317")
            != port.to_string()
    {
        return Err(OtaError::Identity);
    }
    Ok(argv)
}
pub struct RegisteredService {
    pub home: PathBuf,
    pub port: u16,
    pub process: ProcessIdentity,
    pub executable: PathBuf,
}
impl RegisteredService {
    pub fn endpoint(&self) -> ServiceEndpoint<'_> {
        ServiceEndpoint {
            home: &self.home,
            port: self.port,
            process: &self.process,
            executable: &self.executable,
        }
    }
}
/// Registration and loaded job are read independently of public HTTP PID claims.
pub fn inspect_registered_service(
    user_home: &Path,
    home: &Path,
    port: u16,
    trust: &ReleaseTrust,
) -> Result<RegisteredService, OtaError> {
    let observed = observe_service_registration(user_home, home, port, trust)?;
    trust.verify_process(&observed.process, CodeRole::Cli)?;
    trust.verify_static(&observed.executable, CodeRole::Cli)?;
    Ok(RegisteredService {
        home: observed.home,
        port: observed.port,
        process: observed.process,
        executable: observed.executable,
    })
}

/// Read-only native ownership observations. These are not a verified endpoint or OTA authority.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservedServiceRegistration {
    pub home: std::path::PathBuf,
    pub port: u16,
    pub process: ProcessIdentity,
    pub executable: std::path::PathBuf,
    pub registration: Vec<u8>,
    pub label: String,
}

fn service_registration_path(user_home: &Path, label: &str, fixture_root: Option<&Path>) -> PathBuf {
    let directory = fixture_root.map(Path::to_path_buf)
        .unwrap_or_else(|| user_home.join("Library/LaunchAgents"));
    directory.join(format!("{label}.plist"))
}

pub fn observe_service_registration(
    user_home: &Path,
    home: &Path,
    port: u16,
    trust: &ReleaseTrust,
) -> Result<ObservedServiceRegistration, OtaError> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let home = home.canonicalize().map_err(|_| OtaError::Identity)?;
    let user_home = user_home.canonicalize().map_err(|_| OtaError::Identity)?;
    let label = if let Some(policy) = trust.fixture_policy() {
        policy.validate_live().map_err(|_| OtaError::Identity)?;
        if home != policy.home || user_home != policy.home || port != policy.port {
            return Err(OtaError::Identity);
        }
        policy.service_label.as_str()
    } else {
        "com.pacer.serve"
    };
    let fixture_registration_dir = trust.fixture_policy().map(|policy| policy.root.join("registrations"));
    let path = service_registration_path(&user_home, label, fixture_registration_dir.as_deref());
    if path.canonicalize().map_err(|_| OtaError::Identity)? != path {
        return Err(OtaError::Identity);
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
        .map_err(|_| OtaError::Identity)?;
    let metadata = file.metadata().map_err(|_| OtaError::Identity)?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::getuid() }
        || metadata.mode() & 0o022 != 0
        || metadata.len() > 65536
    {
        return Err(OtaError::Identity);
    }
    let mut bytes = Vec::new();
    file.take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| OtaError::Io)?;
    if bytes.len() > 65536 {
        return Err(OtaError::Invalid);
    }
    let argv = parse_registration(&bytes, &user_home, &home, port, label)?;
    let definition = super::platform::JobDefinition::from_plist(&bytes)?;
    let loaded = super::platform::copy_user_job(label)?.ok_or(OtaError::Identity)?;
    let pid = definition
        .match_loaded(&loaded)?
        .pid
        .ok_or(OtaError::Identity)?;
    let details = native::process_details(pid)
        .map_err(|_| OtaError::Identity)?
        .ok_or(OtaError::Identity)?;
    let executable = PathBuf::from(&argv[0])
        .canonicalize()
        .map_err(|_| OtaError::Identity)?;
    if details
        .executable
        .canonicalize()
        .map_err(|_| OtaError::Identity)?
        != executable
    {
        return Err(OtaError::Identity);
    }
    Ok(ObservedServiceRegistration {
        home,
        port,
        process: details.identity,
        executable,
        registration: bytes,
        label: label.to_owned(),
    })
}

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DesktopEffect {
    schema: u32,
    kind: String,
    effect_id: String,
    binding: super::wire::Binding,
}
struct Writer {
    stream: UnixStream,
    sequence: u64,
    pending: std::collections::BTreeMap<u64, String>,
}
/// A persistent fresh connection owns native liveness. Public heartbeat is unrelated.
pub struct NativeConnection {
    pub session: ControlSession,
    pub service: ProcessIdentity,
    writer: Mutex<Writer>,
    alive: AtomicBool,
    maintenance: AtomicBool,
    transaction: Mutex<Option<String>>,
    adoption: Mutex<Option<AdoptionReconnectPlan>>,
}
impl NativeConnection {
    pub fn connect(
        endpoint: &ServiceEndpoint<'_>,
        trust: &ReleaseTrust,
        ticket: Option<&LaunchTicket>,
        effect: Arc<dyn Fn(&str) + Send + Sync>,
    ) -> Result<Arc<Self>, OtaError> {
        Self::connect_adoption(endpoint, trust, ticket, None, effect)
    }
    pub fn connect_adoption(
        endpoint: &ServiceEndpoint<'_>,
        trust: &ReleaseTrust,
        ticket: Option<&LaunchTicket>,
        adoption: Option<&AdoptionReconnectPlan>,
        effect: Arc<dyn Fn(&str) + Send + Sync>,
    ) -> Result<Arc<Self>, OtaError> {
        let (mut stream, session) =
            authenticate_service_adoption(endpoint, trust, "desktop", ticket, adoption)?;
        if let Some(plan) = adoption {
            let branch = plan
                .branches()
                .find(|p| {
                    Path::new(&p.executable) == endpoint.executable
                        && p.version == session.service_version
                })
                .ok_or(OtaError::Identity)?;
            if session.session_id != branch.launch_id
                || session.installation.as_ref().map(|i| &i.id) != Some(&branch.installation_id)
            {
                return Err(OtaError::Identity);
            }
        }
        if session.installation.is_none() {
            return Err(OtaError::Identity);
        }
        let writer = stream.try_clone().map_err(|_| OtaError::Io)?;
        let connection = Arc::new(Self {
            session,
            service: endpoint.process.clone(),
            writer: Mutex::new(Writer {
                stream: writer,
                sequence: 0,
                pending: Default::default(),
            }),
            alive: AtomicBool::new(true),
            maintenance: AtomicBool::new(ticket.is_some() || adoption.is_some()),
            transaction: Mutex::new(
                ticket
                    .map(|t| t.transaction_id.clone())
                    .or_else(|| adoption.map(|p| p.transaction_id.clone())),
            ),
            adoption: Mutex::new(adoption.cloned()),
        });
        let reader = connection.clone();
        #[cfg(feature = "ota-fixture")]
        let fixture_trust = trust.clone();
        std::thread::spawn(move || {
            let result = (|| -> Result<(), OtaError> {
                let mut exit_receipt: Option<(String, &str)> = None;
                loop {
                    let value: serde_json::Value = read_frame(&mut stream)?;
                    match value.get("kind").and_then(serde_json::Value::as_str) {
                        Some("effect-accepted") => {
                            verify_shutdown_receipt(
                                &value,
                                exit_receipt.as_ref().map(|(id, _)| id.as_str()),
                            )?;
                            effect(exit_receipt.as_ref().unwrap().1);
                            return Ok(());
                        }
                        Some("alive" | "ready") => {
                            let sequence = value
                                .get("sequence")
                                .and_then(serde_json::Value::as_u64)
                                .ok_or(OtaError::Invalid)?;
                            let expected = reader
                                .writer
                                .lock()
                                .map_err(|_| OtaError::Invalid)?
                                .pending
                                .remove(&sequence)
                                .ok_or(OtaError::Invalid)?;
                            if value.get("schema").and_then(serde_json::Value::as_u64) != Some(1)
                                || value["kind"] != expected
                            {
                                return Err(OtaError::Identity);
                            }
                        }
                        Some("adoption-reconnect") => {
                            #[derive(Deserialize)]
                            #[serde(rename_all = "camelCase", deny_unknown_fields)]
                            struct ReconnectEffect {
                                schema: u32,
                                kind: String,
                                effect_id: String,
                                plan: AdoptionReconnectPlan,
                            }
                            let command: ReconnectEffect =
                                serde_json::from_value(value).map_err(|_| OtaError::Invalid)?;
                            command.plan.validate()?;
                            let own = native::process_details(std::process::id())
                                .map_err(|_| OtaError::Identity)?
                                .ok_or(OtaError::Identity)?;
                            if command.schema != 1
                                || command.kind != "adoption-reconnect"
                                || !identifier(&command.effect_id)
                                || command.plan.desktop != own.identity
                                || command.plan.native_session_id != reader.session.session_id
                                || reader.session.installation.as_ref().map(|i| &i.id)
                                    != Some(&command.plan.installation_id)
                            {
                                return Err(OtaError::Identity);
                            }
                            let mut saved =
                                reader.adoption.lock().map_err(|_| OtaError::Invalid)?;
                            if saved.as_ref().is_some_and(|old| old != &command.plan) {
                                return Err(OtaError::Identity);
                            }
                            *reader.transaction.lock().map_err(|_| OtaError::Invalid)? =
                                Some(command.plan.transaction_id.clone());
                            let reconnect_now = command.plan.recovery;
                            *saved = Some(command.plan);
                            reader.maintenance.store(true, Ordering::SeqCst);
                            effect("maintenance");
                            if reconnect_now
                                && exit_receipt
                                    .replace((command.effect_id.clone(), "adoption-reconnect"))
                                    .is_some()
                            {
                                return Err(OtaError::Invalid);
                            }
                            reader.send(
                                "effect-ack",
                                serde_json::json!({"effectId":command.effect_id}),
                                None,
                            )?;
                        }
                        #[cfg(feature = "ota-fixture")]
                        Some("fixture-shutdown") => {
                            #[derive(Deserialize)]
                            #[serde(rename_all = "camelCase", deny_unknown_fields)]
                            struct FixtureShutdown {
                                schema: u32,
                                kind: String,
                                effect_id: String,
                            }
                            let command: FixtureShutdown =
                                serde_json::from_value(value).map_err(|_| OtaError::Invalid)?;
                            let policy = fixture_trust
                                .fixture_policy()
                                .ok_or(OtaError::Unavailable)?;
                            policy.validate_live().map_err(|_| OtaError::Identity)?;
                            let own = native::process_details(std::process::id())
                                .map_err(|_| OtaError::Identity)?
                                .ok_or(OtaError::Identity)?;
                            fixture_trust.verify_process(&own.identity, CodeRole::Desktop)?;
                            if command.schema != 1
                                || command.kind != "fixture-shutdown"
                                || !identifier(&command.effect_id)
                                || own.executable != policy.current_app.join("Contents/MacOS/pacer")
                            {
                                return Err(OtaError::Identity);
                            }
                            reader.maintenance.store(true, Ordering::SeqCst);
                            effect("maintenance");
                            if exit_receipt
                                .replace((command.effect_id.clone(), "shutdown"))
                                .is_some()
                            {
                                return Err(OtaError::Invalid);
                            }
                            reader.send(
                                "effect-ack",
                                serde_json::json!({"effectId":command.effect_id}),
                                None,
                            )?;
                            // Remain alive until the service confirms it consumed
                            // the ACK; EOF cannot overtake peer verification.
                        }
                        Some("maintenance" | "shutdown" | "resume") => {
                            let command: DesktopEffect =
                                serde_json::from_value(value).map_err(|_| OtaError::Invalid)?;
                            if command.schema != 1
                                || !identifier(&command.effect_id)
                                || command.binding.installation_id
                                    != reader
                                        .session
                                        .installation
                                        .as_ref()
                                        .ok_or(OtaError::Identity)?
                                        .id
                                || command.binding.transaction_id.is_none()
                            {
                                return Err(OtaError::Identity);
                            }
                            let mut transaction =
                                reader.transaction.lock().map_err(|_| OtaError::Invalid)?;
                            if command.kind == "maintenance" {
                                if transaction.as_ref().is_some_and(|tx| {
                                    Some(tx) != command.binding.transaction_id.as_ref()
                                }) {
                                    return Err(OtaError::Identity);
                                }
                                *transaction = command.binding.transaction_id.clone();
                                reader.maintenance.store(true, Ordering::SeqCst);
                                effect("maintenance");
                            } else if *transaction != command.binding.transaction_id
                                || !reader.maintenance.load(Ordering::SeqCst)
                            {
                                return Err(OtaError::Identity);
                            }
                            if command.kind == "shutdown"
                                && exit_receipt
                                    .replace((command.effect_id.clone(), "shutdown"))
                                    .is_some()
                            {
                                return Err(OtaError::Invalid);
                            }
                            reader.send(
                                "effect-ack",
                                serde_json::json!({"effectId":command.effect_id}),
                                None,
                            )?;
                            if command.kind == "resume" {
                                reader.maintenance.store(false, Ordering::SeqCst);
                                *transaction = None;
                                reader
                                    .adoption
                                    .lock()
                                    .map_err(|_| OtaError::Invalid)?
                                    .take();
                                effect("resume");
                            }
                        }
                        _ => return Err(OtaError::Invalid),
                    }
                }
            })();
            let _ = result;
            reader.close();
        });
        let heartbeat = connection.clone();
        std::thread::spawn(move || {
            while heartbeat.alive() {
                std::thread::sleep(std::time::Duration::from_secs(5));
                if heartbeat.alive()
                    && heartbeat
                        .send("heartbeat", serde_json::json!({}), Some("alive"))
                        .is_err()
                {
                    heartbeat.close();
                }
            }
        });
        Ok(connection)
    }
    fn send(
        &self,
        kind: &str,
        fields: serde_json::Value,
        ack: Option<&str>,
    ) -> Result<(), OtaError> {
        if !self.alive() {
            return Err(OtaError::Unavailable);
        }
        let mut writer = self.writer.lock().map_err(|_| OtaError::Invalid)?;
        writer.sequence = writer.sequence.checked_add(1).ok_or(OtaError::Invalid)?;
        let sequence = writer.sequence;
        let mut value = serde_json::json!({"schema":1,"kind":kind,"sessionId":self.session.session_id,"sequence":sequence});
        value
            .as_object_mut()
            .ok_or(OtaError::Invalid)?
            .extend(fields.as_object().ok_or(OtaError::Invalid)?.clone());
        if let Some(ack) = ack {
            if writer.pending.len() >= 8 {
                return Err(OtaError::Invalid);
            }
            writer.pending.insert(sequence, ack.into());
        }
        write_frame(&mut writer.stream, &value)
    }
    pub fn reconnect_plan(&self) -> Option<AdoptionReconnectPlan> {
        self.adoption.lock().ok().and_then(|p| p.clone())
    }
    pub fn document_ready(&self, proof: Option<ReadinessProof>) -> Result<(), OtaError> {
        let mut fields = serde_json::json!({"validStateRead":true,"protocol":3,"serviceVersion":self.session.service_version,"proof":proof});
        if let Some(plan) = self
            .reconnect_plan()
            .filter(|p| p.native_session_id != self.session.session_id)
        {
            let branch = plan
                .branches()
                .find(|p| p.launch_id == self.session.session_id)
                .ok_or(OtaError::Identity)?;
            let own = native::process_details(std::process::id())
                .map_err(|_| OtaError::Identity)?
                .ok_or(OtaError::Identity)?;
            if own.identity != plan.desktop || proof.is_some() {
                return Err(OtaError::Identity);
            }
            fields["adoptionProof"] = serde_json::to_value(AdoptionReadinessProof {
                installation_id: plan.installation_id.clone(),
                transaction_id: plan.transaction_id.clone(),
                resulting_installation_id: branch.installation_id.clone(),
                branch: branch.branch,
                desktop: own.identity,
                native_session_id: self.session.session_id.clone(),
                desktop_version: env!("CARGO_PKG_VERSION").into(),
                service: self.service.clone(),
                service_version: self.session.service_version.clone(),
                protocol: 3,
                desktop_signed_in: true,
                valid_state_read: true,
            })
            .map_err(|_| OtaError::Invalid)?;
        }
        self.send("desktop-ready", fields, Some("ready"))
    }
    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }
    pub fn maintenance_active(&self) -> bool {
        self.maintenance.load(Ordering::SeqCst)
    }
    pub fn close(&self) {
        self.alive.store(false, Ordering::SeqCst);
        if let Ok(writer) = self.writer.lock() {
            let _ = writer.stream.shutdown(std::net::Shutdown::Both);
        }
    }
}

fn managed_action(
    action: &str,
    registered: Option<&Path>,
    bundled: &Path,
    loaded: Option<&super::platform::LoadedJob>,
) -> Result<super::platform::JobChange, OtaError> {
    use super::platform::JobChange;
    if !matches!(action, "install" | "start" | "restart")
        || registered.is_some_and(|path| path != bundled)
    {
        return Err(OtaError::Identity);
    }
    match (registered, loaded) {
        (None, None) if action == "install" => Ok(JobChange::Bootstrap),
        (Some(_), None) => Ok(JobChange::Bootstrap),
        (Some(_), Some(job)) if job.pid.is_none() => Ok(JobChange::Kickstart),
        _ => Err(OtaError::Identity),
    }
}

/// Bounded kernel inventory. No process environments or untrusted executable probes.
// Native audit-token process discovery is unavailable on other platforms.
#[cfg(not(target_os = "macos"))]
pub fn native_process_inventory() -> Result<Vec<native::ProcessDetails>, OtaError> {
    Err(OtaError::Unavailable)
}

#[cfg(target_os = "macos")]
pub fn native_process_inventory() -> Result<Vec<native::ProcessDetails>, OtaError> {
    unsafe extern "C" {
        fn proc_listallpids(buffer: *mut libc::c_void, size: libc::c_int) -> libc::c_int;
        fn proc_name(pid: libc::c_int, buffer: *mut libc::c_void, size: u32) -> libc::c_int;
    }
    let mut pids = vec![0i32; 65536];
    let count = unsafe { proc_listallpids(pids.as_mut_ptr().cast(), (pids.len() * 4) as i32) };
    if count <= 0 || count as usize >= pids.len() {
        return Err(OtaError::Identity);
    }
    let mut result = Vec::new();
    for pid in pids.into_iter().take(count as usize).filter(|pid| *pid > 0) {
        match native::process_details(pid as u32) {
            Ok(Some(details)) if details.uid == unsafe { libc::geteuid() } => result.push(details),
            Ok(Some(_)) | Ok(None) => {}
            Err(_) => {
                let mut name = [0u8; 64];
                let size = unsafe { proc_name(pid, name.as_mut_ptr().cast(), name.len() as u32) };
                if size > 0
                    && std::str::from_utf8(&name[..size as usize])
                        .is_ok_and(|name| name.trim_end_matches('\0').starts_with("pacer"))
                {
                    return Err(OtaError::Identity);
                }
            }
        }
    }
    Ok(result)
}

#[cfg(target_os = "macos")]
fn ordinary_maintenance_clear(home: &Path) -> Result<(), OtaError> {
    use super::platform_fs::{read_owned_file, PrivateDir};
    let updates = home.join("desktop-updates");
    match std::fs::symlink_metadata(&updates) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(OtaError::Identity),
        Ok(_) => {}
    }
    {
        PrivateDir::open(&updates)?;
        match std::fs::symlink_metadata(updates.join("admission.sqlite")) {
            Ok(_) => {
                if !super::recovery_authority::admission_clear(home)? {
                    return Err(OtaError::Busy);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(OtaError::Identity),
        }
        for entry in std::fs::read_dir(&updates).map_err(|_| OtaError::Identity)? {
            let path = entry.map_err(|_| OtaError::Identity)?.path();
            if path.extension().is_some_and(|s| s == "json") {
                let value: serde_json::Value =
                    serde_json::from_slice(&read_owned_file(&path, 262144)?)
                        .map_err(|_| OtaError::Identity)?;
                if !matches!(
                    value["phase"].as_str(),
                    Some("idle" | "available" | "ready" | "complete" | "restored" | "error")
                ) {
                    return Err(OtaError::Busy);
                }
            }
        }
    }
    Ok(())
}

/// First-run registration and stopped managed-service startup. Never adopts or kills.
#[cfg(target_os = "macos")]
pub async fn managed_service_action(
    user_home: &Path,
    home: &Path,
    port: u16,
    action: &str,
    trust: &ReleaseTrust,
) -> Result<(), OtaError> {
    use super::{
        platform::{copy_user_job, JobDefinition, OwnedJob},
        platform_fs::{read_owned_file, PrivateDir},
    };
    use std::{
        collections::BTreeMap,
        fs::OpenOptions,
        os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    };
    let user_home = user_home.canonicalize().map_err(|_| OtaError::Identity)?;
    let own = native::process_details(std::process::id())
        .map_err(|_| OtaError::Identity)?
        .ok_or(OtaError::Identity)?;
    trust.verify_process(&own.identity, CodeRole::Desktop)?;
    let executable = own
        .executable
        .canonicalize()
        .map_err(|_| OtaError::Identity)?;
    let app = executable
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or(OtaError::Identity)?;
    if !app.to_string_lossy().ends_with(".app") || executable != app.join("Contents/MacOS/pacer") {
        return Err(OtaError::Identity);
    }
    let bundled = app.join("Contents/Resources/pacer");
    trust.verify_static(app, CodeRole::Desktop)?;
    trust.verify_static(&bundled, CodeRole::Cli)?;
    trust.verify_static(
        &app.join("Contents/Resources/pacer-update-helper"),
        CodeRole::Helper,
    )?;
    if !home.exists() {
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(home)
            .map_err(|_| OtaError::Identity)?;
    }
    let home = home.canonicalize().map_err(|_| OtaError::Identity)?;
    let home_meta = std::fs::symlink_metadata(&home).map_err(|_| OtaError::Identity)?;
    if !home_meta.is_dir()
        || home_meta.uid() != unsafe { libc::geteuid() }
        || home_meta.mode() & 0o077 != 0
    {
        return Err(OtaError::Identity);
    }
    let (label, registration_dir, locks) = if let Some(policy) = trust.fixture_policy() {
        policy.validate_live().map_err(|_| OtaError::Identity)?;
        if policy.home != home
            || policy.home != user_home
            || policy.port != port
            || policy.current_app != app
        {
            return Err(OtaError::Identity);
        }
        (
            policy.service_label.clone(),
            policy.root.join("registrations"),
            policy.root.join("locks"),
        )
    } else {
        (
            "com.pacer.serve".into(),
            user_home.join("Library/LaunchAgents"),
            PathBuf::from(format!("/private/tmp/pacer-ota-{}", unsafe {
                libc::geteuid()
            })),
        )
    };
    let lock_dir = PrivateDir::create(&locks)?;
    let _locks = lock_dir.acquire_locks(app, &home)?;
    ordinary_maintenance_clear(&home)?;
    let path = registration_dir.join(format!("{label}.plist"));
    let existing = match std::fs::symlink_metadata(&path) {
        Ok(_) => Some(read_owned_file(&path, 131072)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err(OtaError::Identity),
    };
    let loaded = copy_user_job(&label)?;
    let mut environment = BTreeMap::new();
    environment.insert("HOME".into(), user_home.to_string_lossy().into_owned());
    environment.insert("PACER_HOME".into(), home.to_string_lossy().into_owned());
    environment.insert("PACER_PORT".into(), port.to_string());
    environment.insert("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into());
    let definition = if let Some(bytes) = existing.as_ref() {
        let argv = parse_registration(bytes, &user_home, &home, port, &label)?;
        if Path::new(&argv[0]) != bundled {
            return Err(OtaError::Identity);
        }
        JobDefinition::from_plist(bytes)?
    } else {
        JobDefinition {
            label: label.clone(),
            arguments: vec![bundled.to_string_lossy().into_owned(), "serve".into()],
            environment,
            keep_alive: true,
            run_at_load: true,
        }
    };
    let observed = loaded
        .as_ref()
        .map(|v| definition.match_loaded(v))
        .transpose()?;
    let change = managed_action(
        action,
        existing.as_ref().map(|_| bundled.as_path()),
        &bundled,
        observed.as_ref(),
    )?;
    // Before a service exists there is no admission authority to enroll other CLI work.
    for process in native_process_inventory()? {
        if trust
            .fixture_policy()
            .is_some_and(|policy| !policy.permits_path(&process.executable))
        {
            continue;
        }
        if process.identity == own.identity {
            continue;
        }
        let name = process
            .executable
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        if process.executable == bundled || name == "pacer" || name.starts_with("pacer-") {
            return Err(OtaError::Busy);
        }
    }
    let port_guard = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .map_err(|_| OtaError::Busy)?;
    let job = OwnedJob {
        definition,
        plist_path: path.clone(),
        role: CodeRole::Cli,
    };
    if existing.is_none() {
        let bytes = job.definition.to_plist()?;
        job.stage_fixture_registration(trust, &bytes)?;
        for parent in [user_home.join("Library"), registration_dir.clone()] {
            if !parent.exists() {
                std::fs::DirBuilder::new()
                    .mode(0o700)
                    .create(&parent)
                    .map_err(|_| OtaError::Identity)?;
            }
        }
        if registration_dir
            .canonicalize()
            .map_err(|_| OtaError::Identity)?
            != registration_dir
        {
            return Err(OtaError::Identity);
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
            .map_err(|_| OtaError::Identity)?;
        file.write_all(&bytes).map_err(|_| OtaError::Io)?;
        file.sync_all().map_err(|_| OtaError::Io)?;
        std::fs::File::open(&registration_dir)
            .and_then(|f| f.sync_all())
            .map_err(|_| OtaError::Io)?;
    }
    drop(port_guard);
    job.change(trust, change).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FixtureCleanupAck {
    pub schema: u32,
    pub kind: String,
    pub reservation_id: String,
    pub installation_id: String,
    pub service: ProcessIdentity,
    pub desktops: Vec<ProcessIdentity>,
}
/// Dedicated compiled lease only; normal releases never expose a cleanup bypass.
pub fn request_fixture_cleanup(
    endpoint: &ServiceEndpoint<'_>,
    trust: &ReleaseTrust,
) -> Result<FixtureCleanupAck, OtaError> {
    let policy = trust.fixture_policy().ok_or(OtaError::Unavailable)?;
    policy.validate_live().map_err(|_| OtaError::Identity)?;
    if endpoint.home != policy.home || endpoint.port != policy.port {
        return Err(OtaError::Identity);
    }
    let (mut stream, session) = authenticate_service(endpoint, trust, "helper", None)?;
    write_frame(
        &mut stream,
        &serde_json::json!({"schema":1,"kind":"fixture-cleanup","sessionId":session.session_id,"sequence":1}),
    )?;
    let ack: FixtureCleanupAck = read_frame(&mut stream)?;
    if ack.schema != 1
        || ack.kind != "fixture-cleanup"
        || ack.reservation_id != format!("fixture-cleanup-{}", policy.nonce)
        || !identifier(&ack.installation_id)
        || ack.service != *endpoint.process
    {
        return Err(OtaError::Identity);
    }
    if ack.desktops.len() > 32 {
        return Err(OtaError::Invalid);
    }
    Ok(ack)
}
