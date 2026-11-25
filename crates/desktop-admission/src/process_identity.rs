//! Public process metadata, mirroring `src/update/desktop/process-identity.ts`.
//!
//! Reads only public process metadata (pid, boot id, birth), never process
//! environments or credentials. A successful birth query is stable for the
//! process lifetime, so PID reuse across a reboot is still detected.

use std::sync::OnceLock;

/// A live process identity; `same_process` distinguishes a new process from a
/// reused PID by requiring pid, boot id and exact birth to match.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProcessIdentity {
    pub pid: i64,
    pub boot_id: String,
    pub birth: String,
}

/// The current process's identity, computed once and cached.
pub fn own_process_identity() -> Option<ProcessIdentity> {
    static OWN: OnceLock<Option<ProcessIdentity>> = OnceLock::new();
    OWN.get_or_init(|| identity_of(std::process::id() as i64))
        .clone()
}

fn identity_of(pid: i64) -> Option<ProcessIdentity> {
    let boot_id = boot_id()?;
    let birth = process_birth(pid)?;
    Some(ProcessIdentity {
        pid,
        boot_id,
        birth,
    })
}

pub fn same_process(a: &Option<ProcessIdentity>, b: &Option<ProcessIdentity>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

#[cfg(target_os = "macos")]
fn boot_id() -> Option<String> {
    let out = std::process::Command::new("/usr/sbin/sysctl")
        .args(["-n", "kern.bootsessionuuid"])
        .output()
        .ok()?;
    let value = String::from_utf8(out.stdout).ok()?;
    let value = value.trim();
    let bytes = value.as_bytes();
    let valid = bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| {
            if [8usize, 13, 18, 23].contains(&index) {
                *byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        });
    if !out.status.success() || !valid {
        None
    } else {
        Some(value.to_owned())
    }
}

#[cfg(target_os = "linux")]
fn boot_id() -> Option<String> {
    let value = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
    let value = value.trim();
    if value.len() == 36 {
        Some(value.to_owned())
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
fn process_birth(pid: i64) -> Option<String> {
    use libproc::bsd_info::BSDInfo;
    use libproc::proc_pid::pidinfo;
    let raw = i32::try_from(pid).ok()?;
    let info: BSDInfo = pidinfo(raw, 0).ok()?;
    if info.pbi_pid != pid as u32 || info.pbi_start_tvsec == 0 || info.pbi_start_tvusec >= 1_000_000
    {
        return None;
    }
    Some(format!(
        "{}:{}",
        info.pbi_start_tvsec, info.pbi_start_tvusec
    ))
}

#[cfg(target_os = "linux")]
fn process_birth(pid: i64) -> Option<String> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after = stat.get(stat.rfind(')')? + 2..)?;
    let birth = after.split_whitespace().nth(19)?.to_owned();
    if birth.bytes().all(|b| b.is_ascii_digit()) {
        Some(birth)
    } else {
        None
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn boot_id() -> Option<String> {
    None
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_birth(_pid: i64) -> Option<String> {
    None
}
