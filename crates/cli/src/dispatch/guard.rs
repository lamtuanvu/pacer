use serde_json::{Value, json};
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::time::Duration;

const REASON: &str = "pacer: native subagents are blocked for this managed attempt. Request child work with `pacer dispatch child --goal ... --request-id ...`.";

pub(super) fn run(args: &[String]) -> i32 {
    let env: std::collections::HashMap<String, String> = std::env::vars().collect();
    if env.get("PACER_WORK_GRANT").is_some_and(|v| !v.is_empty())
        && !env
            .get("PACER_ENFORCEMENT_TOKEN")
            .is_some_and(|v| !v.is_empty())
    {
        eprintln!("pacer: work grants only allow scoped dispatch commands");
        return 2;
    }
    let planner = args
        .windows(2)
        .find(|pair| pair[0] == "--planner")
        .map(|pair| pair[1].as_str())
        .unwrap_or("");
    if !matches!(planner, "claude-code" | "codex" | "cursor") {
        return 0;
    }
    let stdin = read_hook_stdin();
    let is_bash = serde_json::from_str::<Value>(&stdin)
        .ok()
        .and_then(|raw| raw.get("tool_name")?.as_str().map(str::to_owned))
        .is_some_and(|name| name == "Bash");
    if is_bash {
        if planner == "cursor" {
            println!("{{\"permission\":\"allow\"}}");
        }
        return 0;
    }
    if let Some(path) = env
        .get("PACER_CANARY_MARKER")
        .filter(|path| !path.is_empty())
    {
        write_marker(path, "native-child.denied");
    }
    if !report_denial(&env, planner)
        && let Some(path) = env
            .get("PACER_GUARD_FAILURE_MARKER")
            .filter(|path| !path.is_empty())
    {
        write_marker(path, "guard-report-failed");
    }
    let output = if planner == "cursor" {
        json!({"permission":"deny","user_message":REASON})
    } else {
        json!({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":REASON}})
    };
    println!("{output}");
    0
}

fn read_hook_stdin() -> String {
    // Hook input may be an open pipe. Match src/install/stdin.ts's one-second
    // deadline without keeping the CLI alive for the producer to close it.
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut input = Vec::new();
        let result = std::io::stdin()
            .read_to_end(&mut input)
            .map(|_| String::from_utf8_lossy(&input).into_owned());
        let _ = send.send(result);
    });
    receive
        .recv_timeout(Duration::from_millis(1000))
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default()
}

fn write_marker(path: &str, contents: &str) {
    use std::io::Write;
    let target = std::path::Path::new(path);
    let Some(parent) = target.parent() else {
        return;
    };
    let temp = parent.join(format!(
        ".pacer-guard-{}-{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |time| time.as_nanos())
    ));
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)
    {
        if file.write_all(contents.as_bytes()).is_ok() && file.sync_all().is_ok() {
            let _ = std::fs::hard_link(&temp, target);
        }
        let _ = std::fs::remove_file(&temp);
    }
}

fn report_denial(env: &std::collections::HashMap<String, String>, planner: &str) -> bool {
    let Some(token) = env.get("PACER_ENFORCEMENT_TOKEN") else {
        return false;
    };
    if token.len() != 68
        || !token.starts_with("pet_")
        || !token[4..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return false;
    }
    let port = env.get("PACER_PORT").map_or("4317", String::as_str);
    if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_millis(1500)))
        .max_redirects(0)
        .proxy(None)
        .build();
    let agent = ureq::Agent::new_with_config(config);
    agent
        .post(format!(
            "http://127.0.0.1:{port}/v3/ops/dispatch.enforcement.denied"
        ))
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .send(json!({"agent":planner}).to_string())
        .is_ok_and(|mut response| {
            response.status().is_success()
                && response
                    .body_mut()
                    .read_to_string()
                    .ok()
                    .is_some_and(|body| serde_json::from_str::<Value>(&body).is_ok())
        })
}

#[cfg(test)]
mod tests;
