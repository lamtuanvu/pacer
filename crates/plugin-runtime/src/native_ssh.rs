//! Concrete SSH transport. Fixed TS programs, private multiplexing, no RPC shell source.
use crate::{
    BrokerError,
    native_command::{self, denied},
    native_process::Image,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    os::unix::fs::{DirBuilderExt, MetadataExt},
    path::{Path, PathBuf},
    time::Instant,
};

#[derive(Clone, Debug)]
pub struct SshConfig {
    pub alias: String,
    pub target: String,
    pub fingerprint: String,
}
pub struct NativeSsh {
    pub config: SshConfig,
    pub image: Image,
    pub env: HashMap<String, String>,
    control: PathBuf,
    control_identity: fs::Metadata,
}
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}
pub fn script(name: &str) -> Result<String, BrokerError> {
    let scripts: Value =
        serde_json::from_str(include_str!("native_ssh/scripts.json")).map_err(|_| denied())?;
    scripts[name].as_str().map(str::to_owned).ok_or_else(denied)
}
impl NativeSsh {
    pub fn prepare(
        home: &Path,
        config: SshConfig,
        executable: &str,
        env: HashMap<String, String>,
    ) -> Result<Self, BrokerError> {
        if config.alias.is_empty()
            || !config
                .alias
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            || !config.alias.as_bytes()[0].is_ascii_alphanumeric()
            || config.target.is_empty()
            || config.target.starts_with('-')
            || !config
                .target
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._@-".contains(&b))
        {
            return Err(denied());
        }
        let local = home.join("ssh");
        let control = if local
            .join(format!("cm-{}", "f".repeat(40)))
            .as_os_str()
            .len()
            >= 104
        {
            PathBuf::from(format!(
                "/tmp/pacer-ssh-{}-{}",
                nix::unistd::Uid::current(),
                &format!("{:x}", Sha256::digest(home.as_os_str().as_encoded_bytes()))[..16]
            ))
        } else {
            local
        };
        match fs::DirBuilder::new().mode(0o700).create(&control) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(denied()),
        }
        let identity = fs::symlink_metadata(&control).map_err(|_| denied())?;
        if !identity.is_dir()
            || identity.uid() != nix::unistd::Uid::current().as_raw()
            || identity.mode() & 0o077 != 0
        {
            return Err(denied());
        }
        Ok(Self {
            config,
            image: Image::pin(executable, true)?,
            env,
            control,
            control_identity: identity,
        })
    }
    pub fn check(&self) -> Result<(), BrokerError> {
        self.image.check()?;
        let m = fs::symlink_metadata(&self.control).map_err(|_| denied())?;
        if !m.is_dir()
            || m.dev() != self.control_identity.dev()
            || m.ino() != self.control_identity.ino()
            || m.mode() & 0o077 != 0
        {
            return Err(denied());
        }
        Ok(())
    }
    pub fn argv(
        &self,
        name: &str,
        args: &[String],
        nonce: Option<&str>,
    ) -> Result<Vec<String>, BrokerError> {
        self.check()?;
        let source = script(name)?;
        if args.iter().any(|s| s.contains('\0'))
            || nonce.is_some_and(|n| {
                n.len() != 36
                    || !n
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
            })
        {
            return Err(denied());
        }
        let program = match nonce {
            Some(n) => format!(
                "printf '__PACER_BEGIN__\\n'; ( {source}\n); pacer_result=$?; printf '\\n__PACER_DONE__={n}\\n'; exit \"$pacer_result\""
            ),
            None if name == "BUNDLE_OUT" => source,
            None => format!("printf '__PACER_BEGIN__\\n'; {source}"),
        };
        let mut command = format!("bash -lc {} pacer", quote(&program));
        for arg in args {
            command.push(' ');
            command.push_str(&quote(arg));
        }
        Ok([
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=2",
            "-o",
            "ControlMaster=auto",
            "-o",
        ]
        .into_iter()
        .map(str::to_owned)
        .chain([
            format!("ControlPath={}/cm-%C", self.control.display()),
            "-o".into(),
            "ControlPersist=60".into(),
            "--".into(),
            self.config.target.clone(),
            command,
        ])
        .collect())
    }
    #[allow(clippy::too_many_arguments)]
    pub async fn run(
        &self,
        name: &str,
        args: &[String],
        nonce: Option<&str>,
        input: &[u8],
        timeout_ms: u64,
        max_bytes: usize,
        deadline: Instant,
    ) -> Result<Value, BrokerError> {
        if timeout_ms > 300000 || max_bytes > 524288 || max_bytes == 0 {
            return Err(denied());
        }
        let argv = self.argv(name, args, nonce)?;
        let out = native_command::run(
            &self.image,
            &argv,
            &self.env,
            input,
            timeout_ms,
            max_bytes + 65536,
            deadline,
        )
        .await?;
        self.check()?;
        if out.code == 255 {
            return Err(BrokerError::Effect("SSH connection failed".into()));
        }
        let err = String::from_utf8_lossy(&out.stderr).into_owned();
        if out.timed_out {
            return Ok(json!({"code":out.code,"stdout":"","stderr":err,"timedOut":true}));
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let marker = "__PACER_BEGIN__\n";
        let at = text
            .match_indices(marker)
            .find(|(at, _)| *at == 0 || text.as_bytes()[at - 1] == b'\n')
            .map(|(at, _)| at)
            .ok_or_else(denied)?;
        let stdout = &text[at + marker.len()..];
        if stdout.len() + err.len() > max_bytes {
            return Err(BrokerError::Invalid("SSH output exceeds issued bound"));
        }
        Ok(json!({"code":out.code,"stdout":stdout,"stderr":err,"timedOut":false}))
    }
}
