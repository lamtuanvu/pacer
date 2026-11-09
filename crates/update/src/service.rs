//! `service.status`: the login service's registration file and its service-manager state
//! (`serviceBackend(ctx).status(2000)` in `src/service/index.ts`).
use crate::{js, object, refuse_enforcement};
use pacer_foundation::{Ctx, api::OpFuture};
use serde_json::{Value, json};
use std::{collections::HashMap, path::Path, process::Stdio, time::Duration};

const LABEL: &str = "com.pacer.serve";
const UNIT: &str = "pacer-serve.service";
const TIMEOUT: Duration = Duration::from_millis(2000);

/// TypeScript refuses other platforms. Native OTA fixture builds manage a sandbox label that
/// only the compiled TypeScript fixture policy knows.
pub(crate) fn stays_forwarded(ctx: &Ctx) -> bool {
    match std::env::consts::OS {
        "linux" => false,
        "macos" => ota_fixture(ctx),
        _ => true,
    }
}

fn ota_fixture(ctx: &Ctx) -> bool {
    if option_env!("PACER_OTA_FIXTURE_POLICY").is_some_and(|policy| !policy.is_empty()) {
        return true;
    }
    fn name(path: Option<&Path>) -> Option<&str> {
        path.and_then(Path::file_name).and_then(|n| n.to_str())
    }
    let home = ctx.pacer_home.as_path();
    let parent = home.parent();
    let live = parent.and_then(Path::parent);
    name(Some(home)) == Some("home")
        && name(live) == Some("live")
        && name(live.and_then(Path::parent)) == Some(".work")
        && parent.is_some_and(|p| p.join("ota").is_dir())
}

pub fn service_status(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        refuse_enforcement(ctx)?;
        object(&params)?;
        let mac = cfg!(target_os = "macos");
        let path = if mac {
            ctx.home
                .join("Library/LaunchAgents")
                .join(format!("{LABEL}.plist"))
        } else {
            ctx.home.join(".config/systemd/user").join(UNIT)
        };
        let installed = std::fs::read(&path).is_ok();
        let (running, pid) = if mac {
            let target = format!("gui/{}/{LABEL}", nix::unistd::getuid().as_raw());
            let (code, stdout) = run(&["launchctl", "print", &target]).await;
            let pid = launchd_number(&stdout, "pid");
            (code == Some(0) && pid.is_some_and(|pid| pid > 0.0), pid)
        } else {
            let (code, stdout) = run(&[
                "systemctl",
                "--user",
                "show",
                UNIT,
                "--property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus",
            ])
            .await;
            let data = systemd_fields(&stdout);
            let field = |key: &str| data.get(key).map(String::as_str);
            let running =
                field("ActiveState") == Some("active") && field("SubState") == Some("running");
            let pid = field("MainPID")
                .and_then(js_number)
                .filter(|pid| *pid > 0.0);
            (code == Some(0) && running, pid)
        };
        let mut status = json!({"installed": installed, "running": running});
        if let Some(pid) = pid {
            status["pid"] = js::number(pid);
        }
        Ok(status)
    })
}

/// `ctx.run(argv, 2000)`: a spawn failure reads as exit 127, a timeout or signal as no exit code.
async fn run(argv: &[&str]) -> (Option<i32>, String) {
    let Ok(child) = tokio::process::Command::new(argv[0])
        .args(&argv[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    else {
        return (Some(127), String::new());
    };
    match tokio::time::timeout(TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => (
            output.status.code(),
            String::from_utf8_lossy(&output.stdout).into_owned(),
        ),
        _ => (None, String::new()),
    }
}

/// `parseLaunchd`: the first line reading `<key> = <integer>` between optional whitespace.
pub(crate) fn launchd_number(text: &str, key: &str) -> Option<f64> {
    text.split(js::line_end).find_map(|line| {
        let value = line
            .trim_matches(js::space)
            .strip_prefix(key)?
            .strip_prefix(" = ")?;
        let digits = value.strip_prefix('-').unwrap_or(value);
        (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
            .then(|| value.parse::<f64>().ok())
            .flatten()
    })
}

/// `parseSystemd`: `Object.fromEntries` over `key=value` lines, later keys winning. A line
/// without `=` maps the line minus its last character to the whole line, as `slice(0, -1)` does.
pub(crate) fn systemd_fields(text: &str) -> HashMap<String, String> {
    let mut data = HashMap::new();
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let (key, value) = match line.find('=') {
            Some(at) => (line[..at].to_owned(), line[at + 1..].to_owned()),
            None => {
                let mut key: Vec<u16> = line.encode_utf16().collect();
                key.pop();
                (String::from_utf16_lossy(&key), line.to_owned())
            }
        };
        data.insert(key, value);
    }
    data
}

/// `Number(text)` for a finite result.
pub(crate) fn js_number(text: &str) -> Option<f64> {
    let text = text.trim_matches(js::space);
    if text.is_empty() {
        return Some(0.0);
    }
    let radix = [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ]
    .into_iter()
    .find_map(|(prefix, radix)| text.strip_prefix(prefix).map(|digits| (digits, radix)));
    let value = match radix {
        Some((digits, radix)) => u64::from_str_radix(digits, radix).ok()? as f64,
        None if text
            .chars()
            .all(|c| c.is_ascii_digit() || "+-.eE".contains(c)) =>
        {
            text.parse::<f64>().ok()?
        }
        None => return None,
    };
    value.is_finite().then_some(value)
}
