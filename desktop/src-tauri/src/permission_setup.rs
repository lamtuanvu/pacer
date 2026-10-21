use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

static BUSY: AtomicBool = AtomicBool::new(false);
struct SetupGuard;
impl Drop for SetupGuard {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::Release);
    }
}

#[derive(Debug, Serialize)]
pub struct SetupResult {
    pub status: String,
    pub accessibility: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_name: Option<String>,
}
#[derive(Deserialize)]
struct HelperResult {
    status: String,
    #[serde(default)]
    accessibility: bool,
    host_app: Option<String>,
    target_pid: Option<u32>,
}

pub async fn request() -> Result<SetupResult, String> {
    #[cfg(target_os = "macos")]
    {
        execute(&helper_path()?).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Native validation setup is available in the macOS desktop app".into())
    }
}

#[cfg(target_os = "macos")]
fn helper_path() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let bundled = executable
        .parent()
        .ok_or("Desktop executable has no directory")?
        .join("pacer-permission-setup");
    if bundled.is_file() {
        return Ok(bundled);
    }
    #[cfg(debug_assertions)]
    {
        let staged = PathBuf::from(env!("PACER_PERMISSION_HELPER"));
        if staged.is_file() {
            return Ok(staged);
        }
    }
    Err("The bundled native validation helper is missing; rebuild or reinstall Pacer".into())
}

async fn execute(helper: &Path) -> Result<SetupResult, String> {
    BUSY.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "Native validation setup is already open".to_owned())?;
    let _guard = SetupGuard;
    let pid = std::process::id();
    use tokio::io::AsyncReadExt;
    let mut child = tokio::process::Command::new(helper)
        .arg(pid.to_string())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("Could not start native validation setup: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Native setup output is unavailable")?;
    let (status, output) = tokio::time::timeout(std::time::Duration::from_secs(190), async {
        let mut output = Vec::new();
        stdout
            .take(16385)
            .read_to_end(&mut output)
            .await
            .map_err(|error| error.to_string())?;
        if output.len() > 16384 {
            return Err("Native validation helper returned an invalid response".to_owned());
        }
        let status = child.wait().await.map_err(|error| error.to_string())?;
        Ok((status, output))
    })
    .await
    .map_err(|_| "Native validation setup timed out".to_owned())??;
    if !status.success() {
        return Err("Native validation helper returned an invalid response".into());
    }
    let response: HelperResult = serde_json::from_slice(&output)
        .map_err(|_| "Native validation helper returned an invalid response".to_owned())?;
    if ![
        "verified",
        "cancelled",
        "timeout",
        "settings_closed",
        "target_exited",
        "target_unavailable",
        "host_unknown",
        "settings_unavailable",
        "already_open",
        "setup_unavailable",
    ]
    .contains(&response.status.as_str())
    {
        return Err("Native validation helper returned an unknown status".into());
    }
    if response.status == "verified"
        && (!response.accessibility || response.target_pid != Some(pid))
    {
        return Err("Native validation helper did not prove owned-window verification".into());
    }
    let host_name = response
        .host_app
        .as_deref()
        .and_then(|path| Path::new(path).file_stem())
        .and_then(|name| name.to_str())
        .map(str::to_owned);
    Ok(SetupResult {
        status: response.status,
        accessibility: response.accessibility,
        host_name,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn setup_serializes_owned_helpers_and_rejects_false_verification() {
        use std::{fs, os::unix::fs::PermissionsExt};
        let root = std::env::temp_dir().join(format!("pacer-permission-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let helper = root.join("helper");
        fs::write(&helper,"#!/bin/sh\n/bin/sleep 0.2\nprintf '%s' '{\"status\":\"cancelled\",\"accessibility\":false}'\n").unwrap();
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
        let owned = helper.clone();
        let running = tokio::spawn(async move { execute(&owned).await });
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert!(execute(&helper).await.unwrap_err().contains("already open"));
        assert_eq!(running.await.unwrap().unwrap().status, "cancelled");
        fs::write(
            &helper,
            "#!/bin/sh\nprintf '%s' '{\"status\":\"verified\",\"accessibility\":false}'\n",
        )
        .unwrap();
        assert!(execute(&helper).await.unwrap_err().contains("verification"));
        fs::write(&helper,format!("#!/bin/sh\nprintf '%s' '{{\"status\":\"verified\",\"accessibility\":true,\"target_pid\":{}}}'\n",std::process::id()+1)).unwrap();
        assert!(execute(&helper).await.unwrap_err().contains("verification"));
        fs::write(
            &helper,
            "#!/bin/sh\nprintf '%s' '{\"status\":\"cancelled\",\"accessibility\":false}'\n",
        )
        .unwrap();
        assert_eq!(execute(&helper).await.unwrap().status, "cancelled");
        fs::remove_dir_all(root).unwrap();
    }
}
