//! Native authority is compiled into signed desktop builds, never enabled by runtime env.
use std::io;
use std::path::PathBuf;

/// Code-signing identifiers for one build flavour.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NativeIdentifiers {
    pub app: &'static str,
    pub cli: &'static str,
    pub helper: &'static str,
}
pub const RELEASE_IDENTIFIERS: NativeIdentifiers = NativeIdentifiers {
    app: "dev.pacer.desktop",
    cli: "dev.pacer.cli",
    helper: "dev.pacer.desktop.update-helper",
};
pub const FIXTURE_IDENTIFIERS: NativeIdentifiers = NativeIdentifiers {
    app: "dev.pacer.desktop.fixture",
    cli: "dev.pacer.desktop.fixture.cli",
    helper: "dev.pacer.desktop.fixture.update-helper",
};
pub const fn native_identifiers(fixture: bool) -> NativeIdentifiers {
    if fixture {
        FIXTURE_IDENTIFIERS
    } else {
        RELEASE_IDENTIFIERS
    }
}
/// Only the live harness's fixture build compiles with the flag "1"; release builds clear it.
const fn compiled_fixture(flag: Option<&str>) -> bool {
    match flag {
        Some(value) => matches!(value.as_bytes(), [b'1']),
        None => false,
    }
}
/// Compile-time selection, like the signer pins. Runtime environment cannot change it.
pub const IDENTIFIERS: NativeIdentifiers =
    native_identifiers(compiled_fixture(option_env!("PACER_BUILD_DESKTOP_FIXTURE")));

#[derive(Clone, Copy)]
pub enum NativeRole {
    Cli,
    Desktop,
    Helper,
}
#[derive(Clone)]
pub struct NativeTrust {
    cli: String,
    desktop: String,
    helper: String,
}
impl NativeTrust {
    pub fn from_pins(team: Option<&str>, certificate: Option<&str>) -> io::Result<Option<Self>> {
        let Some(cli) = signer_requirement(team, certificate, IDENTIFIERS.cli)? else {
            return Ok(None);
        };
        let desktop = signer_requirement(team, certificate, IDENTIFIERS.app)?
            .ok_or_else(|| io::Error::other("native signing policy unavailable"))?;
        let helper = signer_requirement(team, certificate, IDENTIFIERS.helper)?
            .ok_or_else(|| io::Error::other("native helper signing policy unavailable"))?;
        Ok(Some(Self {
            cli,
            desktop,
            helper,
        }))
    }
    pub fn compiled() -> io::Result<Option<Self>> {
        Self::from_pins(
            option_env!("PACER_BUILD_APPLE_TEAM_ID"),
            option_env!("PACER_BUILD_SIGNING_CERT_SHA1"),
        )
    }
    pub fn verify_static(&self, path: &std::path::Path, role: NativeRole) -> io::Result<()> {
        use core_foundation::url::CFURL;
        use security_framework::os::macos::code_signing::{Flags, SecRequirement, SecStaticCode};
        let denied = || io::Error::other("native code identity unavailable");
        let source = match role {
            NativeRole::Cli => &self.cli,
            NativeRole::Desktop => &self.desktop,
            NativeRole::Helper => &self.helper,
        };
        let requirement: SecRequirement = source.parse().map_err(|_| denied())?;
        let url = CFURL::from_path(path, path.is_dir()).ok_or_else(denied)?;
        let code = SecStaticCode::from_path(&url, Flags::NONE).map_err(|_| denied())?;
        code.check_validity(
            Flags::STRICT_VALIDATE | Flags::CHECK_NESTED_CODE | Flags::CHECK_ALL_ARCHITECTURES,
            &requirement,
        )
        .map_err(|_| denied())
    }
    pub fn verify_current(&self) -> io::Result<ProcessDetails> {
        use security_framework::os::macos::code_signing::{Flags, SecCode, SecRequirement};
        let denied = || io::Error::other("native code identity unavailable");
        let before = process_details(std::process::id())?;
        if before.uid != nix::unistd::getuid().as_raw() {
            return Err(denied());
        }
        let requirement: SecRequirement = self.cli.parse().map_err(|_| denied())?;
        SecCode::for_self(Flags::NONE)
            .map_err(|_| denied())?
            .check_validity(Flags::NONE, &requirement)
            .map_err(|_| denied())?;
        if before != process_details(std::process::id())? {
            return Err(denied());
        }
        Ok(before)
    }
    pub fn verify_helper_image(
        &self,
        child: Option<&tokio::process::Child>,
        path: &std::path::Path,
        cdhash: &str,
    ) -> io::Result<()> {
        use core_foundation::url::CFURL;
        use security_framework::os::macos::code_signing::{
            Flags, GuestAttributes, SecCode, SecRequirement, SecStaticCode,
        };
        let denied = || io::Error::other("native helper image unavailable");
        if cdhash.len() != 40 || !cdhash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(denied());
        }
        let requirement: SecRequirement = format!("({}) and cdhash H\"{}\"", self.helper, cdhash)
            .parse()
            .map_err(|_| denied())?;
        let url = CFURL::from_path(path, false).ok_or_else(denied)?;
        SecStaticCode::from_path(&url, Flags::NONE)
            .map_err(|_| denied())?
            .check_validity(Flags::STRICT_VALIDATE, &requirement)
            .map_err(|_| denied())?;
        if let Some(child) = child {
            let pid = child.id().ok_or_else(denied)?;
            let before = process_details(pid)?;
            if before.uid != nix::unistd::getuid().as_raw()
                || before.parent_pid != std::process::id()
                || before.executable != path
            {
                return Err(denied());
            }
            let mut attrs = GuestAttributes::new();
            attrs.set_pid(i32::try_from(pid).map_err(|_| denied())?);
            SecCode::copy_guest_with_attribues(None, &attrs, Flags::NONE)
                .map_err(|_| denied())?
                .check_validity(Flags::NONE, &requirement)
                .map_err(|_| denied())?;
            if before != process_details(pid)? || child.id() != Some(pid) {
                return Err(denied());
            }
        }
        Ok(())
    }
    pub fn verify_generation(&self, expected: &ProcessDetails) -> io::Result<()> {
        use security_framework::os::macos::code_signing::{
            Flags, GuestAttributes, SecCode, SecRequirement,
        };
        let denied = || io::Error::other("native core generation unavailable");
        if expected.parent_pid != std::process::id()
            || expected != &process_details(expected.process.pid)?
        {
            return Err(denied());
        }
        let mut attrs = GuestAttributes::new();
        attrs.set_pid(i32::try_from(expected.process.pid).map_err(|_| denied())?);
        let requirement: SecRequirement = self.cli.parse().map_err(|_| denied())?;
        SecCode::copy_guest_with_attribues(None, &attrs, Flags::NONE)
            .map_err(|_| denied())?
            .check_validity(Flags::NONE, &requirement)
            .map_err(|_| denied())?;
        if expected != &process_details(expected.process.pid)? {
            return Err(denied());
        }
        Ok(())
    }
    /// Caller retains this owned, unreaped child throughout verification.
    pub fn verify_child(
        &self,
        child: &tokio::process::Child,
        core: &std::path::Path,
    ) -> io::Result<ProcessDetails> {
        use security_framework::os::macos::code_signing::{
            Flags, GuestAttributes, SecCode, SecRequirement,
        };
        let denied = || io::Error::other("native core identity unavailable");
        let pid = child.id().ok_or_else(denied)?;
        let before = process_details(pid)?;
        if before.uid != nix::unistd::getuid().as_raw()
            || before.parent_pid != std::process::id()
            || before.executable != core
            || core.canonicalize()? != core
        {
            return Err(denied());
        }
        let requirement: SecRequirement = self.cli.parse().map_err(|_| denied())?;
        let mut attributes = GuestAttributes::new();
        attributes.set_pid(i32::try_from(pid).map_err(|_| denied())?);
        let code = SecCode::copy_guest_with_attribues(None, &attributes, Flags::NONE)
            .map_err(|_| denied())?;
        code.check_validity(Flags::NONE, &requirement)
            .map_err(|_| denied())?;
        if before != process_details(pid)? || child.id() != Some(pid) {
            return Err(denied());
        }
        Ok(before)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub boot_id: String,
    pub birth: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessDetails {
    pub process: ProcessIdentity,
    pub uid: u32,
    pub parent_pid: u32,
    pub executable: PathBuf,
}
pub fn process_details(pid: u32) -> io::Result<ProcessDetails> {
    use libproc::{
        bsd_info::BSDInfo,
        proc_pid::{pidinfo, pidpath},
    };
    use std::sync::OnceLock;
    static BOOT: OnceLock<Result<String, String>> = OnceLock::new();
    let denied = || io::Error::other("native process metadata unavailable");
    let raw = i32::try_from(pid).map_err(|_| denied())?;
    if raw <= 0 {
        return Err(denied());
    }
    let boot = BOOT
        .get_or_init(|| {
            let output = std::process::Command::new("/usr/sbin/sysctl")
                .args(["-n", "kern.bootsessionuuid"])
                .output()
                .map_err(|_| "boot identity unavailable".to_owned())?;
            let value = String::from_utf8(output.stdout)
                .map_err(|_| "boot identity unavailable".to_owned())?;
            let value = value.trim();
            if !output.status.success()
                || value.len() != 36
                || !value.bytes().enumerate().all(|(index, byte)| {
                    if [8, 13, 18, 23].contains(&index) {
                        byte == b'-'
                    } else {
                        byte.is_ascii_hexdigit()
                    }
                })
            {
                return Err("boot identity unavailable".to_owned());
            }
            Ok(value.to_owned())
        })
        .as_ref()
        .map_err(|_| denied())?;
    let info: BSDInfo = pidinfo(raw, 0).map_err(|_| denied())?;
    if info.pbi_pid != pid
        || info.pbi_status == 5
        || info.pbi_start_tvsec == 0
        || info.pbi_start_tvusec >= 1_000_000
    {
        return Err(denied());
    }
    let executable = std::fs::canonicalize(pidpath(raw).map_err(|_| denied())?)?;
    Ok(ProcessDetails {
        process: ProcessIdentity {
            pid,
            boot_id: boot.clone(),
            birth: format!("{}:{}", info.pbi_start_tvsec, info.pbi_start_tvusec),
        },
        uid: info.pbi_uid,
        parent_pid: info.pbi_ppid,
        executable,
    })
}

pub fn signer_requirement(
    team: Option<&str>,
    certificate: Option<&str>,
    identifier: &str,
) -> io::Result<Option<String>> {
    let denied = || io::Error::other("invalid compiled native signing policy");
    let team = team.filter(|value| !value.is_empty());
    let certificate = certificate.filter(|value| !value.is_empty());
    if identifier.is_empty()
        || !identifier
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
        || team.is_some_and(|value| {
            value.len() != 10
                || !value
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        })
        || certificate.is_some_and(|value| {
            value.len() != 40
                || !value
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
        })
    {
        return Err(denied());
    }
    Ok(match (team, certificate) {
        (None, None) => None,
        (Some(team), None) => Some(format!(
            "anchor apple generic and identifier \"{identifier}\" and certificate leaf[subject.OU] = \"{team}\""
        )),
        (None, Some(cert)) => Some(format!(
            "identifier \"{identifier}\" and certificate leaf = H\"{cert}\""
        )),
        (Some(team), Some(cert)) => Some(format!(
            "identifier \"{identifier}\" and ((anchor apple generic and certificate leaf[subject.OU] = \"{team}\") or certificate leaf = H\"{cert}\")"
        )),
    })
}

#[cfg(test)]
#[path = "native_trust_tests.rs"]
mod tests;
