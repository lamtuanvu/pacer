//! Native process incarnations and awake time. No process environments or credentials.
use serde::{Deserialize, Serialize};
use std::{io, path::PathBuf};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessIdentity {
    pub pid: u32,
    pub boot_id: String,
    pub birth: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AwakeStamp {
    pub boot_id: String,
    pub millis: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessDetails {
    pub identity: ProcessIdentity,
    pub executable: PathBuf,
    pub uid: u32,
    pub parent_pid: u32,
}

pub fn elapsed_ms(start: &AwakeStamp, now: &AwakeStamp) -> io::Result<u64> {
    if start.boot_id.is_empty() || start.boot_id != now.boot_id {
        return Err(io::Error::other("Awake clock belongs to another boot"));
    }
    now.millis
        .checked_sub(start.millis)
        .ok_or_else(|| io::Error::other("Awake clock regressed"))
}

#[cfg(target_os = "macos")]
pub use darwin::{awake_now, process_details};
#[cfg(not(target_os = "macos"))]
pub fn awake_now() -> io::Result<AwakeStamp> {
    Err(io::ErrorKind::Unsupported.into())
}
#[cfg(not(target_os = "macos"))]
pub fn process_details(_pid: u32) -> io::Result<Option<ProcessDetails>> {
    Err(io::ErrorKind::Unsupported.into())
}

#[cfg(target_os = "macos")]
mod darwin {
    use super::*;
    use std::os::unix::ffi::OsStringExt;
    #[repr(C)]
    struct Timebase {
        numer: u32,
        denom: u32,
    }
    unsafe extern "C" {
        fn mach_absolute_time() -> u64;
        fn mach_timebase_info(info: *mut Timebase) -> i32;
        fn proc_pidinfo(
            pid: i32,
            flavor: i32,
            arg: u64,
            buffer: *mut libc::c_void,
            size: i32,
        ) -> i32;
        fn proc_pidpath(pid: i32, buffer: *mut libc::c_void, size: u32) -> i32;
    }
    fn boot_id() -> io::Result<String> {
        let mut bytes = [0u8; 64];
        let mut size = bytes.len();
        let rc = unsafe {
            libc::sysctlbyname(
                c"kern.bootsessionuuid".as_ptr(),
                bytes.as_mut_ptr().cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        if size == 0 || size > bytes.len() {
            return Err(io::Error::other("Invalid boot identity"));
        }
        let value = std::str::from_utf8(&bytes[..size])
            .map_err(io::Error::other)?
            .trim_end_matches('\0');
        if value.len() != 36 || !value.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
            return Err(io::Error::other("Invalid boot identity"));
        }
        Ok(value.to_owned())
    }
    /// mach_absolute_time excludes sleep. Do not substitute mach_continuous_time.
    /// Apple mach_time.h and required-reason category SystemBootTime/35F9.1.
    pub fn awake_now() -> io::Result<AwakeStamp> {
        let mut scale = Timebase { numer: 0, denom: 0 };
        if unsafe { mach_timebase_info(&mut scale) } != 0 || scale.numer == 0 || scale.denom == 0 {
            return Err(io::Error::other("Awake clock timebase unavailable"));
        }
        let nanos = u128::from(unsafe { mach_absolute_time() })
            .checked_mul(u128::from(scale.numer))
            .ok_or_else(|| io::Error::other("Awake clock overflow"))?
            / u128::from(scale.denom);
        let millis = u64::try_from(nanos / 1_000_000).map_err(io::Error::other)?;
        Ok(AwakeStamp {
            boot_id: boot_id()?,
            millis,
        })
    }
    fn bsd_info(pid: i32) -> io::Result<Option<[u64; 17]>> {
        let mut data = [0u64; 17]; // aligned proc_bsdinfo: 136 bytes on supported Darwin ABIs
        let length = unsafe { proc_pidinfo(pid, 3, 0, data.as_mut_ptr().cast(), 136) };
        if length != 136 {
            let error = io::Error::last_os_error();
            return if length == 0
                && matches!(error.raw_os_error(), Some(libc::ESRCH | libc::ENOENT))
            {
                Ok(None)
            } else {
                Err(error)
            };
        }
        Ok(Some(data))
    }
    fn u32_at(data: &[u64; 17], at: usize) -> u32 {
        let raw = data[at / 8].to_ne_bytes();
        u32::from_ne_bytes(raw[at % 8..at % 8 + 4].try_into().unwrap())
    }
    pub fn process_details(pid: u32) -> io::Result<Option<ProcessDetails>> {
        let pid = i32::try_from(pid).map_err(io::Error::other)?;
        if pid <= 0 {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let Some(before) = bsd_info(pid)? else {
            return Ok(None);
        };
        if before[15] == 0 || before[16] >= 1_000_000 || u32_at(&before, 12) != pid as u32 {
            return Err(io::Error::other("Invalid process identity"));
        }
        let mut path = [0u8; 4096];
        let size = unsafe { proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
        if size <= 0 || size as usize >= path.len() {
            return Err(io::Error::last_os_error());
        }
        let end = path
            .iter()
            .position(|b| *b == 0)
            .ok_or_else(|| io::Error::other("Invalid executable path"))?;
        let executable = PathBuf::from(std::ffi::OsString::from_vec(path[..end].to_vec()));
        if !executable.is_absolute() {
            return Err(io::Error::other("Invalid executable path"));
        }
        let Some(after) = bsd_info(pid)? else {
            return Ok(None);
        };
        if before[15..] != after[15..]
            || u32_at(&before, 20) != u32_at(&after, 20)
            || u32_at(&before, 16) != u32_at(&after, 16)
        {
            return Err(io::Error::other(
                "Process identity changed during inspection",
            ));
        }
        Ok(Some(ProcessDetails {
            identity: ProcessIdentity {
                pid: pid as u32,
                boot_id: boot_id()?,
                birth: format!("{}:{}", before[15], before[16]),
            },
            executable,
            uid: u32_at(&before, 20),
            parent_pid: u32_at(&before, 16),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn elapsed_time_is_bound_to_one_boot_and_cannot_regress() {
        let start = AwakeStamp {
            boot_id: "boot-one".into(),
            millis: 42,
        };
        assert_eq!(
            elapsed_ms(
                &start,
                &AwakeStamp {
                    boot_id: "boot-one".into(),
                    millis: 120041
                }
            )
            .unwrap(),
            119999
        );
        assert_eq!(
            elapsed_ms(
                &start,
                &AwakeStamp {
                    boot_id: "boot-one".into(),
                    millis: 120042
                }
            )
            .unwrap(),
            120000
        );
        assert!(elapsed_ms(
            &start,
            &AwakeStamp {
                boot_id: "boot-two".into(),
                millis: 120042
            }
        )
        .is_err());
        assert!(elapsed_ms(
            &start,
            &AwakeStamp {
                boot_id: "boot-one".into(),
                millis: 41
            }
        )
        .is_err());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn actual_awake_clock_advances_and_retains_boot_identity() {
        let before = awake_now().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let after = awake_now().unwrap();
        assert_eq!(before.boot_id.len(), 36);
        assert_eq!(before.boot_id, after.boot_id);
        assert!(elapsed_ms(&before, &after).unwrap() > 0);
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn native_process_identity_distinguishes_live_child_and_reaped_exit() {
        let own = process_details(std::process::id()).unwrap().unwrap();
        assert_eq!(own.identity.pid, std::process::id());
        assert_eq!(
            own.executable.canonicalize().unwrap(),
            std::env::current_exe().unwrap().canonicalize().unwrap()
        );
        assert_eq!(own, process_details(std::process::id()).unwrap().unwrap());
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("0.1")
            .spawn()
            .unwrap();
        let details = process_details(child.id()).unwrap().unwrap();
        assert_eq!(details.parent_pid, own.identity.pid);
        assert_eq!(details.uid, own.uid);
        assert_eq!(details.identity.boot_id, own.identity.boot_id);
        assert_ne!(details.identity, own.identity);
        child.wait().unwrap();
        assert_eq!(process_details(child.id()).unwrap(), None);
    }
}
