//! Native authority is compiled into signed desktop builds, never enabled by runtime env.
use std::io;
use std::path::PathBuf;

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
